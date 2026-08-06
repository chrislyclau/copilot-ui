SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR=$SCRIPT_DIR/../lhs-hosting-platform

pushd $HOST_DIR


docker run --name lhs-hosting-platform --rm -it -d \
    -v ".://app" \
    bash

popd

model="claude-sonnet-4.6"

REVIEWER_PROVIDER=copilot-native REVIEWER_MODEL=$model npm run agent:task

pushd $HOST_DIR

docker stop lhs-hosting-platform

popd