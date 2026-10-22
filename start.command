#!/bin/bash
cd "$(dirname "$0")"
(sleep 2; open http://localhost:4000) &
node server.js
