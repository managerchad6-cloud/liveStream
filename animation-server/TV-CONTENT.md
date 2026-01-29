# TV Content Service

The TV Content Service displays images and videos on the in-scene TV viewport, composited into the animated stream.

## Overview

- Content appears on the TV screen in the background (behind characters)
- Supports images (PNG, JPG, GIF) and videos (MP4, WebM, etc.)
- Playlist-based playback with controls
- Content is scaled to fit the TV viewport (preserving aspect ratio)
- Frame-synced at 15fps with the animation render loop

## API Endpoints

### Playlist Management

#### Add Item to Playlist
```bash
POST /tv/playlist/add
Content-Type: application/json

{
  "type": "image",           # "image" or "video"
  "source": "/path/to/file", # Local path or URL
  "duration": 10             # Optional: seconds for images (default: 10)
}
```

Response:
```json
{
  "success": true,
  "item": {
    "id": "uuid",
    "type": "image",
    "source": "/path/to/file",
    "duration": 10
  }
}
```

#### Upload File
```bash
POST /tv/upload
Content-Type: multipart/form-data

file: <binary>
type: "image" or "video"  # Optional, auto-detected from mimetype
duration: 10              # Optional, for images
```

#### Remove Item
```bash
DELETE /tv/playlist/:id
```

#### Get Playlist
```bash
GET /tv/playlist
```

Response:
```json
{
  "playlist": [
    {
      "id": "uuid",
      "type": "video",
      "source": "/path/to/video.mp4",
      "duration": 30.5,
      "frameCount": 457,
      "loaded": true,
      "error": null
    }
  ],
  "status": {
    "state": "playing",
    "currentIndex": 0,
    "frameIndex": 120,
    "playlistLength": 1,
    "currentItem": { ... }
  }
}
```

#### Clear Playlist
```bash
POST /tv/playlist/clear
```

### Playback Control

#### Control Playback
```bash
POST /tv/control
Content-Type: application/json

{
  "action": "play"  # play, pause, stop, next, prev
}
```

#### Get Status
```bash
GET /tv/status
```

Response:
```json
{
  "status": {
    "state": "playing",
    "currentIndex": 0,
    "frameIndex": 45,
    "playlistLength": 2,
    "currentItem": {
      "id": "...",
      "type": "video",
      "source": "...",
      "duration": 10,
      "frameCount": 150,
      "loaded": true
    }
  },
  "viewport": {
    "x": 546,
    "y": 112,
    "width": 315,
    "height": 166
  }
}
```

## Content Types

| Type | Source | Behavior |
|------|--------|----------|
| image | Local path | Scaled to viewport, displayed for `duration` seconds |
| image | URL | Fetched, scaled, displayed for `duration` seconds |
| video | Local path | Decoded at 15fps, frames played sequentially |
| video | URL | FFmpeg handles URL directly |

## Example Usage

### Display a local image for 5 seconds
```bash
curl -X POST http://localhost:3003/tv/playlist/add \
  -H "Content-Type: application/json" \
  -d '{"type":"image","source":"/home/user/image.jpg","duration":5}'

curl -X POST http://localhost:3003/tv/control \
  -d '{"action":"play"}'
```

### Upload and play a video
```bash
curl -X POST http://localhost:3003/tv/upload \
  -F "file=@/path/to/video.mp4" \
  -F "type=video"

curl -X POST http://localhost:3003/tv/control \
  -d '{"action":"play"}'
```

### Play an image from URL
```bash
curl -X POST http://localhost:3003/tv/playlist/add \
  -H "Content-Type: application/json" \
  -d '{"type":"image","source":"https://example.com/image.png","duration":10}'
```

### Skip to next item
```bash
curl -X POST http://localhost:3003/tv/control \
  -H "Content-Type: application/json" \
  -d '{"action":"next"}'
```

### Stop playback
```bash
curl -X POST http://localhost:3003/tv/control \
  -H "Content-Type: application/json" \
  -d '{"action":"stop"}'
```

## Technical Details

- **Viewport**: Extracted from `mask.png` in exported-layers
- **Resolution**: Content scaled to viewport size (~315x166 at 1/3 output scale)
- **Framerate**: 15fps (synced with render loop)
- **Video Decoding**: FFmpeg pipe-based, no temp files
- **Image Handling**: Single frame repeated for duration
- **Compositing**: TV content drawn after static base, before character layers

## File Storage

Uploaded files are stored in:
```
animation-server/tv-content/content/
```

This directory is gitignored. Files are not automatically cleaned up.

## Playback States

| State | Description |
|-------|-------------|
| stopped | No playback, reset to beginning |
| playing | Active playback, frames advancing |
| paused | Frozen on current frame |

When an item ends, playback automatically advances to the next item in the playlist (loops back to start).
