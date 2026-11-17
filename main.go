package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func reservePort() (int, error) {
	listener, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	return port, listener.Close()
}

func startBackend(directory string, port int) (*exec.Cmd, error) {
	command := exec.Command("node", "--experimental-strip-types", "backend.ts", strconv.Itoa(port))
	command.Dir = directory
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(10 * time.Second)
	address := "127.0.0.1:" + strconv.Itoa(port)
	for time.Now().Before(deadline) {
		connection, dialErr := net.DialTimeout("tcp4", address, 20*time.Millisecond)
		if dialErr == nil {
			_ = connection.Close()
			return command, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = command.Process.Kill()
	return nil, errors.New("TypeScript backend did not start")
}

func controlRequest(client *http.Client, method, endpoint string, body io.Reader) (*http.Response, error) {
	request, err := http.NewRequest(method, endpoint, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return client.Do(request)
}

func register(client *http.Client, base string, port int) error {
	payload, _ := json.Marshal(map[string]int{"port": port})
	delay := 100 * time.Millisecond
	for attempt := 0; attempt < 20; attempt++ {
		response, err := controlRequest(client, http.MethodPost, base+"/register", bytes.NewReader(payload))
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == 200 || response.StatusCode == 409 {
				return nil
			}
			if response.StatusCode == 400 || response.StatusCode == 405 {
				return fmt.Errorf("register status %d", response.StatusCode)
			}
		}
		time.Sleep(delay)
		delay = min(delay*2, 1500*time.Millisecond)
	}
	return errors.New("register failed after 20 attempts")
}

func waitDone(client *http.Client, base string) error {
	for {
		response, err := controlRequest(client, http.MethodGet, base+"/done", nil)
		if err == nil {
			var answer struct {
				Done bool `json:"done"`
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&answer)
			_ = response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 && decodeErr == nil && answer.Done {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func main() {
	directory, err := filepath.Abs(filepath.Dir(os.Args[0]))
	if err != nil {
		panic(err)
	}
	port, err := reservePort()
	if err != nil {
		panic(err)
	}
	backend, err := startBackend(directory, port)
	if err != nil {
		panic(err)
	}
	defer func() { _ = backend.Process.Kill(); _, _ = backend.Process.Wait() }()

	base := strings.TrimRight(strings.TrimSpace(os.Getenv("MAKEFUN_ENV_URL")), "/")
	if base == "" {
		panic("MAKEFUN_ENV_URL is empty")
	}
	client := &http.Client{Timeout: 3 * time.Second}
	if err := register(client, base, port); err != nil {
		panic(err)
	}

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- waitDone(client, base) }()
	select {
	case err = <-done:
	case <-interrupt:
	}
	if err != nil {
		panic(err)
	}
}
