#!/bin/bash

# cd to the root of the project
cd $(dirname $0)/..

# Clean up river block cache and all directories in the .river directory
rm -rf .river
mkdir -p .river