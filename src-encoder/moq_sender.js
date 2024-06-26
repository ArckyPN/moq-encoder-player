/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum } from './utils.js'
import { moqCreate, moqClose, moqParseSubscribe, moqCreateControlStream, moqSendSubscribeResponse, moqSendObjectToWriter, moqSendSetup, moqParseSetupResponse, MOQ_PARAMETER_ROLE_PUBLISHER, MOQ_PARAMETER_ROLE_SUBSCRIBER, MOQ_PARAMETER_ROLE_BOTH, moqSendAnnounce, moqParseAnnounceResponse } from '../utils/moqt.js'
import { LocPackager } from '../packager/loc_packager.js'
import { RawPackager } from '../packager/raw_packager.js'

const WORKER_PREFIX = '[MOQ-SENDER]'

let moqPublisherState = {}

let workerState = StateEnum.Created

let isSendingStats = true

let tracks = {}
// Example
/* moqTracks: {
    "audio": {
        id: 0,
        maxInFlightRequests: 100,
        isHipri: true,
        authInfo: "secret"
    },
    "video": {
        id: 1,
        maxInFlightRequests: 50,
        isHipri: false,
        authInfo: "secret"
    }
} */

// Inflight req abort signal
const abortController = new AbortController()
let inFlightRequests = {}

// MOQT data
const moqt = moqCreate()

self.addEventListener('message', async function (e) {
  if (workerState === StateEnum.Created) {
    workerState = StateEnum.Instantiated
  }

  if (workerState === StateEnum.Stopped) {
    sendMessageToMain(WORKER_PREFIX, 'info', 'Muxer-send is stopped it does not accept messages')
    return
  }

  const type = e.data.type
  if (type === 'stop') {
    workerState = StateEnum.Stopped

    // Abort and wait for all inflight requests
    try {
      abortController.abort()
      await Promise.all(getAllInflightRequestsArray())
    } catch (err) {
      // Expected to finish some promises with abort error
      // The abort "errors" are already sent to main "thead" by sendMessageToMain inside the promise
      sendMessageToMain(WORKER_PREFIX, 'info', `Aborting streams while exiting. Err: ${err.message}`)
    } finally {
      await moqClose(moqt)
    }
    return
  }

  if (type === 'muxersendini') {
    if (workerState !== StateEnum.Instantiated) {
      sendMessageToMain(WORKER_PREFIX, 'error', 'received ini message in wrong state. State: ' + workerState)
      return
    }

    let urlHostPortEp = ''

    if ('urlHostPort' in e.data.muxerSenderConfig) {
      urlHostPortEp = e.data.muxerSenderConfig.urlHostPort
    }
    if ('isSendingStats' in e.data.muxerSenderConfig) {
      isSendingStats = e.data.muxerSenderConfig.isSendingStats
    }
    if ('moqTracks' in e.data.muxerSenderConfig) {
      tracks = e.data.muxerSenderConfig.moqTracks
    }

    if (urlHostPortEp === '') {
      sendMessageToMain(WORKER_PREFIX, 'error', 'Empty host port')
      return
    }
    const errTrackStr = checkTrackData()
    if (errTrackStr !== '') {
      sendMessageToMain(WORKER_PREFIX, 'error', errTrackStr)
      return
    }

    try {
      // Reset state
      moqResetState()
      await moqClose(moqt)

      // WT needs https to establish connection
      const url = new URL(urlHostPortEp)
      // Replace protocol
      url.protocol = 'https'

      // Chrome needs a fingerprint of the certificate
      const options = {
        serverCertificateHashes: [
            {
                algorithm: "sha-256",
                value: new Uint8Array(JSON.parse(await (await this.fetch("/fingerprint.txt", { method: "GET" })).text()))
            }
        ]
    }

      // Ini WT
      // eslint-disable-next-line no-undef
      moqt.wt = new WebTransport(url.href, options)
      moqt.wt.closed
        .then(() => {
          sendMessageToMain(WORKER_PREFIX, 'info', 'WT closed transport session')
        })
        .catch(error => {
          sendMessageToMain(WORKER_PREFIX, 'error', 'WT error, closed transport. Err: ' + error)
        })

      await moqt.wt.ready
      await moqCreateControlStream(moqt)
      await moqCreatePublisherSession(moqt)

      inFlightRequests = initInflightReqData(tracks)

      sendMessageToMain(WORKER_PREFIX, 'info', 'MOQ Initialized, waiting for subscriptions')
      workerState = StateEnum.Running

      startLoopSubscriptionsLoop(moqt.controlReader, moqt.controlWriter)
        .then(_ => {
          sendMessageToMain(WORKER_PREFIX, 'info', 'Exited receiving subscription loop in control stream')
        })
        .catch(err => {
          if (workerState !== StateEnum.Stopped) {
            sendMessageToMain(WORKER_PREFIX, 'error', `Error in the subscription loop in control stream. Err: ${JSON.stringify(err)}`)
          } else {
            sendMessageToMain(WORKER_PREFIX, 'info', `Exited receiving subscription loop in control stream. Err: ${JSON.stringify(err)}`)
          }
        })
    } catch (err) {
      sendMessageToMain(WORKER_PREFIX, 'error', `Initializing MOQ. Err: ${JSON.stringify(err)}`)
    }

    return
  }

  if (workerState !== StateEnum.Running) {
    sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId: e.data.seqId, ts: e.data.chunk.timestamp, msg: 'Dropped chunk because transport is NOT open yet' })
    return
  }

  if (!(type in tracks)) {
    sendMessageToMain(WORKER_PREFIX, 'error', `Invalid message received ${type} is NOT in tracks ${JSON.stringify(tracks)}`)
    return
  }

  if (!('numSubscribers' in tracks[type]) || (tracks[type].numSubscribers <= 0)) {
    sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId: e.data.seqId, ts: e.data.chunk.timestamp, msg: `Dropped chunk because there is NO subscribers for track ${type}` })
    return
  }

  const firstFrameClkms = (e.data.firstFrameClkms === undefined || e.data.firstFrameClkms < 0) ? 0 : e.data.firstFrameClkms
  const compensatedTs = (e.data.compensatedTs === undefined || e.data.compensatedTs < 0) ? 0 : e.data.compensatedTs
  const estimatedDuration = (e.data.estimatedDuration === undefined || e.data.estimatedDuration < 0) ? e.data.chunk.duration : e.data.estimatedDuration
  const seqId = (e.data.seqId === undefined) ? 0 : e.data.seqId

  const chunkData = { mediaType: type, firstFrameClkms, compensatedTs, estimatedDuration, seqId, chunk: e.data.chunk, metadata: e.data.metadata }
  sendChunkToTransport(chunkData, inFlightRequests[type], tracks[type].maxInFlightRequests)
    .then(val => {
      if (val !== undefined && val.dropped === true) {
        sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId, mediaType: type, ts: chunkData.timestamp, msg: val.message })
      } else {
        sendMessageToMain(WORKER_PREFIX, 'debug', `SENT CHUNK ${type} - ${seqId}`)
      }
    })
    .catch(err => {
      sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId, mediaType: chunkData.mediaType, ts: chunkData.timestamp, msg: err.message })
      sendMessageToMain(WORKER_PREFIX, 'error', 'error sending chunk. Err:  ' + err.message)
    })

  // Report stats
  if (isSendingStats) {
    self.postMessage({ type: 'sendstats', clkms: Date.now(), inFlightReq: getInflightRequestsReport() })
  }
})

async function startLoopSubscriptionsLoop (controlReader, controlWriter) {
  sendMessageToMain(WORKER_PREFIX, 'info', 'Started subscription loop')

  while (workerState === StateEnum.Running) {
    const subscribe = await moqParseSubscribe(controlReader)
    const track = getTrack(subscribe.namespace, subscribe.trackName)
    if (track == null) {
      sendMessageToMain(WORKER_PREFIX, 'error', `Invalid subscribe received ${subscribe.namespace}/${subscribe.trackName} is NOT in tracks ${JSON.stringify(tracks)}`)
    } else {
      if (track.authInfo !== subscribe.parameters.authInfo) {
        sendMessageToMain(WORKER_PREFIX, 'error', `Invalid subscribe authInfo ${subscribe.parameters.authInfo} does not match with ${JSON.stringify(tracks)}`)
      } else {
        if ('numSubscribers' in track) {
          track.numSubscribers++
        } else {
          track.numSubscribers = 1
        }
        sendMessageToMain(WORKER_PREFIX, 'info', `New subscriber for track ${subscribe.namespace}/${subscribe.trackName}. Current num subscriber: ${track.numSubscribers}. AuthInfo MATCHED!`)
        await moqSendSubscribeResponse(controlWriter, subscribe.namespace, subscribe.trackName, track.id, 0)
      }
    }
  }
}

async function sendChunkToTransport (chunkData, inFlightRequests, maxFlightRequests) {
  if (chunkData == null) {
    return { dropped: true, message: 'chunkData is null' }
  }
  if (Object.keys(inFlightRequests).length >= maxFlightRequests) {
    return { dropped: true, message: 'too many inflight requests' }
  }
  return createRequest(chunkData)
}

async function createRequest (chunkData) {
  let packet = null

  if (chunkData.mediaType === 'data') {
    // Simple
    packet = new RawPackager()
    packet.SetData(chunkData.mediaType, 'key', chunkData.seqId, chunkData.chunk)
  } else {
    // Media LOC packager
    packet = new LocPackager()
    // actual bytes of encoded data
    const chunkDataBuffer = new Uint8Array(chunkData.chunk.byteLength)
    chunkData.chunk.copyTo(chunkDataBuffer)

    packet.SetData(chunkData.mediaType, chunkData.compensatedTs, chunkData.estimatedDuration, chunkData.chunk.type, chunkData.seqId, chunkData.firstFrameClkms, chunkData.metadata, chunkDataBuffer)
  }
  return createSendPromise(packet)
}

async function createSendPromise (packet) {
  if (moqt.wt === null) {
    throw new Error(`request not send because transport is NOT open. For ${packet.GetData().mediaType} - ${packet.GetData().seqId}`)
  }

  if (!(packet.GetData().mediaType in tracks)) {
    throw new Error(`OBJECT mediaType NOT supported (no track found), received ${packet.GetData().mediaType}, tracks: ${JSON.stringify(tracks)}`)
  }
  const trackId = tracks[packet.GetData().mediaType].id

  if (!(trackId in moqPublisherState)) {
    if (packet.GetData().chunkType === 'delta') {
      return { dropped: true, message: `Dropped chunk because first object can not be delta, data: ${packet.GetDataStr()}` }
    }
    moqPublisherState[trackId] = createTrackState()
  }

  const sendOrder = moqCalculateSendOrder(packet)

  const uniStream = await moqt.wt.createUnidirectionalStream({ options: { sendOrder } })
  const uniWriter = uniStream.getWriter()

  // Group sequence, Using it as a joining point
  if (packet.GetData().chunkType !== 'delta') {
    moqPublisherState[trackId].currentGroupSeq++
    moqPublisherState[trackId].currentObjectSeq = 0
  }

  const groupSeq = moqPublisherState[trackId].currentGroupSeq
  const objSeq = moqPublisherState[trackId].currentObjectSeq

  sendMessageToMain(WORKER_PREFIX, 'debug', `Sending MOQT ${trackId}/${groupSeq}/${objSeq}(${sendOrder}). Data: ${packet.GetDataStr()}`)

  moqSendObjectToWriter(uniWriter, trackId, groupSeq, objSeq, sendOrder, packet.ToBytes())

  moqPublisherState[trackId].currentObjectSeq++

  // Write async here
  const p = uniWriter.close()
  p.id = packet.GetData().pId

  addToInflight(packet.GetData().mediaType, p)

  p.finally(() => {
    removeFromInflight(packet.GetData().mediaType, packet.GetData().pId)
  })

  return p
}

function addToInflight (mediaType, p) {
  if (p.id in inFlightRequests[mediaType]) {
    sendMessageToMain(WORKER_PREFIX, 'error', 'id already exists in inflight, this should never happen')
  } else {
    inFlightRequests[mediaType][p.id] = p
  }
}

function removeFromInflight (mediaType, id) {
  if (id in inFlightRequests[mediaType]) {
    delete inFlightRequests[mediaType][id]
  }
}

// MOQT

async function moqCreatePublisherSession (moqt) {
  // SETUP
  await moqSendSetup(moqt.controlWriter, MOQ_PARAMETER_ROLE_PUBLISHER)
  const setupResponse = await moqParseSetupResponse(moqt.controlReader)
  sendMessageToMain(WORKER_PREFIX, 'info', `Received SETUP response: ${JSON.stringify(setupResponse)}`)
  if (setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_SUBSCRIBER && setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_BOTH) {
    throw new Error(`role not supported. Supported  ${MOQ_PARAMETER_ROLE_SUBSCRIBER}, got from server ${JSON.stringify(setupResponse.parameters.role)}`)
  }

  // ANNOUNCE
  const announcedNamespaces = []
  for (const [trackType, trackData] of Object.entries(tracks)) {
    if (!announcedNamespaces.includes(trackData.namespace)) {
      await moqSendAnnounce(moqt.controlWriter, trackData.namespace, trackData.authInfo)
      const announceResp = await moqParseAnnounceResponse(moqt.controlReader)
      sendMessageToMain(WORKER_PREFIX, 'info', `Received ANNOUNCE response for ${trackData.id}-${trackType}-${trackData.namespace}: ${JSON.stringify(announceResp)}`)
      if (trackData.namespace !== announceResp.namespace) {
        throw new Error(`expecting namespace ${trackData.namespace}, got ${JSON.stringify(announceResp)}`)
      }
      announcedNamespaces.push(trackData.namespace)
    }
  }
}

function checkTrackData () {
  if (Object.entries(tracks).length <= 0) {
    return 'Number of Track Ids to announce needs to be > 0'
  }
  for (const [, track] of Object.entries(tracks)) {
    if (!('namespace' in track) || !('name' in track) || !('authInfo' in track)) {
      return 'Track malformed, needs to contain namespace, name, and authInfo'
    }
  }
  return ''
}

function initInflightReqData () {
  const ret = {}
  for (const [trackType] of Object.entries(tracks)) {
    ret[trackType] = {}
  }
  return ret
}

function moqResetState () {
  moqPublisherState = {}
}

function moqCalculateSendOrder (packet) {
  // Prioritize:
  // Audio over video
  // New over old

  let ret = packet.GetData().seqId
  if (ret < 0) {
    // Send now
    ret = Number.MAX_SAFE_INTEGER
  } else {
    if (tracks[packet.GetData().mediaType].isHipri) {
      ret = Math.floor(ret + Number.MAX_SAFE_INTEGER / 2)
    }
  }
  return ret
}

function createTrackState () {
  return {
    currentGroupSeq: 0,
    currentObjectSeq: 0
  }
}

function getTrack (namespace, trackName) {
  for (const [, trackData] of Object.entries(tracks)) {
    if (trackData.namespace === namespace && trackData.name === trackName) {
      return trackData
    }
  }
  return null
}

function getAllInflightRequestsArray () {
  let ret = []
  for (const [trackType] of Object.entries(tracks)) {
    ret = ret.concat(ret, Object.values(inFlightRequests[trackType]))
  }
  return ret
}

function getInflightRequestsReport () {
  const ret = {}
  for (const [trackType] of Object.entries(tracks)) {
    ret[trackType] = Object.keys(inFlightRequests[trackType]).length
  }
  return ret
}
