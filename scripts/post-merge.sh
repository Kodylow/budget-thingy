#!/bin/bash
set -eu
# A merge is not a database release. No dependency resolution or business data
# changes belong in this short hook; see docs/database-setup.md.
echo "Merge complete. Dependency/setup changes require the explicit release workflow in docs/database-setup.md."
