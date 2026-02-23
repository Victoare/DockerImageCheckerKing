# Docker Image Checker King 🐳

Web-based tool that checks your Docker containers for outdated images by comparing local digests against remote registry digests (therefore no unneccessry image pulls). Supports one-click container updates via a "Clone & Swap" pattern.

Responsive design, light/dark themes

![alt text](other/Screenshot_desktop.png)

![alt text](other/Screenshot_mobile.png)

## Quick Start

```yaml
# docker-compose.yml
services:
  docker-image-checker-king:
    image: victoare/docker-image-checker-king:latest
    container_name: docker-image-checker-king
    ports:
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
    environment:
      - AUTO_CHECK_FAST_MINUTES=60
      - AUTO_CHECK_MINUTES=360
    restart: unless-stopped
```

```bash
docker compose up -d
```

Open **http://localhost:8080** in your browser.

## Build from source

```bash
git clone https://github.com/YOUR_USER/docker-image-checker-king.git
cd docker-image-checker-king
docker build -t docker-image-checker-king ./source
```

## Features

- **No image pulls** — uses Docker Registry v2 API to fetch manifests and compare digests
- **One-click updates** — "Clone & Swap" pattern: stop → rename → pull → create → start → remove old
- **Anonymous auth** where possible (Docker Hub, ghcr.io, gcr.io, quay.io, ECR Public)
- **Digest caching** — same image referenced by multiple containers is only checked once per run
- **Real-time progress** via Server-Sent Events (SSE)
- **Includes stopped containers** — always checks all containers, not just running ones
- **Persistent results** — saved to disk and restored on page load
- **Auto-check scheduler** — adapts interval based on Docker Hub rate limits
- **Clickable stat cards** — filter by Up to date / Outdated / Unknown / Total
- **Responsive table** — columns collapse progressively on smaller screens
- **Dark/Light theme** — toggle persisted in localStorage

## Authentication

| Registry | Auth Method |
|---|---|
| Docker Hub (docker.io) | Anonymous token (100 req/6h per IP) |
| ghcr.io | Anonymous for public images |
| gcr.io / Artifact Registry | Anonymous for public images |
| quay.io | Anonymous for public images |
| public.ecr.aws | Anonymous for public images |
| **Private registries** | **Requires `docker login` on the host** |

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Path to Docker socket |
| `DATA_DIR` | `/data` | Data directory for JSON files |
| `AUTO_CHECK_FAST_MINUTES` | `60` | Auto-check interval when rate limits are healthy |
| `AUTO_CHECK_MINUTES` | `360` | Auto-check interval when rate limits are low |

## Architecture

```
Browser  ──SSE──►  Express (Node.js)  ──unix socket──►  Docker Engine API
                        │
                        ├──► Registry v2 API (HEAD /v2/.../manifests/<tag>)
                        ├──► Token endpoints (auth.docker.io, ghcr.io/token, etc.)
                        └──► /data/*.json  (persists results across restarts)
```

## Good Vibes Only

Idea out of pure frustration by Victoare

Mostly vibe coded using Claude Opus 4.6 by anthropic. 

Logo image made by ChatGPT

## License

[MIT](LICENSE)

![alt text](source/public/favicon/android-chrome-512x512.png)