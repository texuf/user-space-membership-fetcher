#!/bin/bash

# Load environment variables from .env.local
if [ -f ".env.local" ]; then
  export $(grep -v '^#' .env.local | xargs)
fi

# Check if BEARER_TOKEN is set
if [ -z "$BEARER_TOKEN" ]; then
  echo "Error: BEARER_TOKEN environment variable is not set"
  echo "Please add BEARER_TOKEN to your .env.local file"
  exit 1
fi

while true; do
  
  start=$(gdate +%s%3N)
  
  response=$(curl -s -w "%{http_code}" -H "Authorization: Bearer $BEARER_TOKEN" \
    https://gateway-worker-test-beta.towns.com/operators)
  
  # Check if response has enough content
  if [[ ${#response} -ge 3 ]]; then
    http_code="${response: -3}"
    body="${response}"
  else
    http_code="000"
    body="$response"
  fi
  
  end=$(gdate +%s%3N)
  elapsed=$((end - start))

  if [[ "$http_code" == "200" ]]; then
    echo "✅ Success [$elapsed ms]: ${body:0:100}"
  else
    echo "❌ FAILED with HTTP $http_code [$elapsed ms]"
    echo "${body:0:100}"
  fi
  sleep 1
done

