package main

import (
	"flag"
	"log"
	"net/http"
)

func main() {
	var (
		err     error
		addr    *string = flag.String("addr", ":8080", "the address to listen on, default :8080")
		server  http.Server
		handler *http.ServeMux
	)
	log.SetFlags(log.Lmicroseconds | log.Lshortfile)

	handler = &http.ServeMux{}

	// static file host
	handler.Handle("/", http.FileServer(http.Dir(".")))

	server = http.Server{
		Addr:    *addr,
		Handler: handler,
	}

	log.Printf("Listening on http://localhost%s\n", *addr)
	log.Printf("MoQ Encoder running on http://localhost%s/src-encoder/\n", *addr)
	log.Printf("MoQ Player running on http://localhost%s/src-player/\n", *addr)
	if err = server.ListenAndServe(); err != nil {
		log.Panicf("ErrServe: %s\n", err)
	}
}
