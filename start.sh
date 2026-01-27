#!/bin/bash

echo "Starting LiveStream Animation System..."
echo ""

# Start API server in background
node server.js &
API_PID=$!
echo "API Server started (PID: $API_PID)"

sleep 2

# Start animation server in background
cd animation-server && node server.js &
ANIM_PID=$!
echo "Animation Server started (PID: $ANIM_PID)"

cd ..

echo ""
echo "Servers running:"
echo "  API Server: http://localhost:3002"
echo "  Animation Server: http://localhost:3003"
echo ""
echo "Open http://localhost:3002 in your browser"
echo ""
echo "Press Ctrl+C to stop all servers"

# Wait for Ctrl+C
trap "kill $API_PID $ANIM_PID 2>/dev/null; exit" INT TERM
wait
