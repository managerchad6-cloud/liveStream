# Chatbox MVP

A minimal MVP chatbox that connects to OpenAI API and ElevenLabs for voice responses.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Ensure your `.env` file contains:
```
OPENAI_API_KEY=your_api_key_here
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
MODEL=gpt-4o-mini
PORT=3000
```

## Running

Start the server:
```bash
npm start
```

Then open your browser and navigate to:
```
http://localhost:3000
```

## Usage

1. Type a message in the chatbox
2. Click "Submit" or press Enter
3. The response from OpenAI will be converted to speech using ElevenLabs and played automatically

## Features

- Simple POST /chat endpoint
- OpenAI API integration for text generation
- ElevenLabs text-to-speech for audio output
- Basic message history display (user messages only)
- No authentication or persistence
- Livestream host-style responses (short, conversational)
