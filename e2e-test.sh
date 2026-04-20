#!/bin/bash

echo "============================================"
echo " TunnelNet E2E Test"
echo "============================================"
echo ""

# ── STEP 0: Aggressive cleanup ──
echo ">>> STEP 0: Aggressive cleanup of all processes"
# Kill by port first (most reliable)
for port in 3000 3002 3013 9999; do
  fuser -k ${port}/tcp 2>/dev/null || true
done
# Kill by pattern
pkill -9 -f "next" 2>/dev/null || true
pkill -9 -f "bun.*index.ts" 2>/dev/null || true  
pkill -9 -f "tunnel-client" 2>/dev/null || true
pkill -9 -f "local-test-server" 2>/dev/null || true
sleep 5

# Verify ports are free
for port in 3000 3013 9999; do
  if fuser ${port}/tcp >/dev/null 2>&1; then
    echo "    WARNING: Port $port still in use, force killing..."
    fuser -k -9 ${port}/tcp 2>/dev/null || true
    sleep 2
  fi
done
echo "    DONE All processes cleaned"
echo ""

# ── STEP 1: Remove ALL .db files and caches ──
echo ">>> STEP 1: Remove all .db files and caches"
rm -f /home/z/my-project/db/custom.db
rm -rf /home/z/my-project/.next
rm -f /home/z/my-project/dev.log /home/z/my-project/server.log
rm -rf /home/z/my-project/prisma/db /home/z/my-project/mini-services/db
echo "    DONE Cleaned up"
echo ""

# ── STEP 2: Init DB ──
echo ">>> STEP 2: Initialize database"
cd /home/z/my-project
mkdir -p db

echo "    Running prisma db push..."
DATABASE_URL="file:/home/z/my-project/db/custom.db" bunx prisma db push --accept-data-loss 2>&1 | tail -3
echo "    Running prisma generate..."
DATABASE_URL="file:/home/z/my-project/db/custom.db" bunx prisma generate 2>&1 | tail -3
echo "    Copying .prisma to tunnel-server..."
cp -r node_modules/.prisma mini-services/tunnel-server/node_modules/.prisma 2>/dev/null || true
echo "    DONE Database initialized"
echo ""

# ── STEP 3: Start tunnel-server ──
echo ">>> STEP 3: Start tunnel-server on port 3013"
cd /home/z/my-project/mini-services/tunnel-server
DATABASE_URL="file:/home/z/my-project/db/custom.db" TUNNEL_PORT=3013 \
  nohup bun index.ts > /tmp/tunnel-server.log 2>&1 &
TUNNEL_PID=$!
echo "    PID: $TUNNEL_PID"
sleep 4

# Verify
if curl -s -f http://127.0.0.1:3013/api/tunnel/status > /dev/null 2>&1; then
  echo "    DONE tunnel-server is running"
else
  echo "    FAIL tunnel-server not responding"
  cat /tmp/tunnel-server.log
  exit 1
fi
echo ""

# ── STEP 4: Start Next.js ──
echo ">>> STEP 4: Start Next.js on port 3000"
cd /home/z/my-project
DATABASE_URL="file:/home/z/my-project/db/custom.db" \
  nohup bun next dev -H :: -p 3000 > /tmp/nextjs.log 2>&1 &
NEXT_PID=$!
echo "    PID: $NEXT_PID"

echo "    Waiting for Next.js (up to 20s)..."
for i in $(seq 1 20); do
  RESP=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/tunnels 2>/dev/null)
  if [ "$RESP" = "200" ]; then
    echo "    DONE Next.js ready after ${i}s"
    break
  fi
  if [ $i -eq 20 ]; then
    echo "    FAIL Next.js NOT ready after 20s"
    tail -20 /tmp/nextjs.log
    exit 1
  fi
  sleep 1
done
echo ""

# ── STEP 5: Create tunnel ──
echo ">>> STEP 5: Create tunnel via POST /api/tunnels"
CREATE_RESP=$(curl -s -X POST http://127.0.0.1:3000/api/tunnels \
  -H "Content-Type: application/json" \
  -d '{"name":"T","localPort":9999}' 2>&1)
echo "    Response: $CREATE_RESP"

TCODE=$(echo "$CREATE_RESP" | jq -r ".tunnel.tunnelCode // empty")
if [ -z "$TCODE" ]; then
  echo "    FAIL Could not extract tunnelCode"
  exit 1
fi
echo "    Tunnel Code: $TCODE"
echo "    DONE Tunnel created"
echo ""

# ── STEP 6: Verify tunnel-server sees the tunnel ──
echo ">>> STEP 6: Verify tunnel-server sees the tunnel"
TUNNEL_STATUS=$(curl -s http://127.0.0.1:3013/api/tunnel/status 2>&1)
TUNNEL_COUNT=$(echo "$TUNNEL_STATUS" | jq ".tunnels | length")
echo "    Tunnels in DB: $TUNNEL_COUNT"
if [ "$TUNNEL_COUNT" -lt 1 ]; then
  echo "    FAIL tunnel-server sees no tunnels"
  exit 1
fi
echo "    DONE tunnel-server sees the tunnel"
echo ""

# ── STEP 7: Start local test server ──
echo ">>> STEP 7: Start local test server on port 9999"
nohup bun /tmp/local-test-server.ts > /tmp/local-server.log 2>&1 &
LOCAL_PID=$!
echo "    PID: $LOCAL_PID"
sleep 2

LOCAL_RESP=$(curl -s http://127.0.0.1:9999/hi 2>&1)
echo "    Response: $LOCAL_RESP"
if echo "$LOCAL_RESP" | grep -q "Hello from local service"; then
  echo "    DONE Local server working"
else
  echo "    FAIL Local server not working"
  exit 1
fi
echo ""

# ── STEP 8: Start tunnel client ──
echo ">>> STEP 8: Start tunnel client with key=$TCODE"
cd /home/z/my-project
nohup bun download/tunnel-client.ts --key "$TCODE" --port 9999 --server 127.0.0.1:3013 > /tmp/tunnel-client.log 2>&1 &
CLIENT_PID=$!
echo "    PID: $CLIENT_PID"
sleep 5

CLIENT_LOG=$(cat /tmp/tunnel-client.log 2>/dev/null)
echo "    Client log:"
echo "$CLIENT_LOG" | sed "s/^/      /"
if echo "$CLIENT_LOG" | grep -q "隧道已建立"; then
  echo "    DONE Client connected"
else
  echo "    FAIL Client did not show '隧道已建立'"
  echo "    Tunnel server log:"
  tail -10 /tmp/tunnel-server.log | sed "s/^/      /"
  exit 1
fi
echo ""

# ── STEP 9: Test proxy - /hello ──
echo ">>> STEP 9: Test proxy - http://127.0.0.1:3013/$TCODE/hello"
PROXY_RESP=$(curl -s --max-time 10 http://127.0.0.1:3013/$TCODE/hello 2>&1)
echo "    Response: $PROXY_RESP"
if echo "$PROXY_RESP" | grep -q "Hello from local service"; then
  echo "    DONE Proxy /hello PASSED"
else
  echo "    FAIL Proxy /hello FAILED"
  exit 1
fi
echo ""

# ── STEP 10: Test proxy - /api/data ──
echo ">>> STEP 10: Test proxy - http://127.0.0.1:3013/$TCODE/api/data"
PROXY_RESP2=$(curl -s --max-time 10 http://127.0.0.1:3013/$TCODE/api/data 2>&1)
echo "    Response: $PROXY_RESP2"
if echo "$PROXY_RESP2" | grep -q "Hello from local service"; then
  echo "    DONE Proxy /api/data PASSED"
else
  echo "    FAIL Proxy /api/data FAILED"
  exit 1
fi
echo ""

# ── STEP 11: Cleanup ──
echo ">>> STEP 11: Cleanup"
kill $TUNNEL_PID $NEXT_PID $LOCAL_PID $CLIENT_PID 2>/dev/null || true
for port in 3000 3013 9999; do
  fuser -k ${port}/tcp 2>/dev/null || true
done
sleep 1
echo "    DONE All processes killed"
echo ""

echo "============================================"
echo " ALL E2E TESTS PASSED!"
echo "============================================"
