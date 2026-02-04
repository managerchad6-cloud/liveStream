#!/bin/bash

# Analyze directory and output JSON for .claudeignore recommendations

echo "{"
echo "  \"total_files\": $(find . -type f 2>/dev/null | wc -l),"
echo "  \"total_size_mb\": \"$(du -sm . 2>/dev/null | cut -f1)\","
echo "  \"large_directories\": ["

# Find large directories (>50MB)
first=true
du -sm */ .* 2>/dev/null | sort -rn | while read size dir; do
  if [ "$size" -gt 50 ]; then
    [ "$first" = false ] && echo ","
    echo -n "    {\"path\": \"$dir\", \"size_mb\": $size}"
    first=false
  fi
done

echo ""
echo "  ],"
echo "  \"runtime_directories\": ["

# Check for runtime/generated content
runtime_dirs=("streams/" "node_modules/" "dist/" "build/" ".cache/" "tmp/" "temp/")
first=true
for dir in "${runtime_dirs[@]}"; do
  if [ -d "$dir" ]; then
    size=$(du -sm "$dir" 2>/dev/null | cut -f1)
    [ "$first" = false ] && echo ","
    echo -n "    {\"path\": \"$dir\", \"size_mb\": $size, \"type\": \"runtime\"}"
    first=false
  fi
done

echo ""
echo "  ],"
echo "  \"file_extensions\": {"

# Count files by extension
echo -n "    \"media\": $(find . -type f \( -name "*.mp4" -o -name "*.mp3" -o -name "*.wav" -o -name "*.ts" -o -name "*.m3u8" \) 2>/dev/null | wc -l),"
echo -n "    \"images\": $(find . -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.psd" \) 2>/dev/null | wc -l),"
echo "    \"logs\": $(find . -type f -name "*.log" 2>/dev/null | wc -l)"

echo "  },"
echo "  \"recommendations\": ["

# Generate recommendations
rec_first=true

# Check streams/
if [ -d "streams/" ]; then
  [ "$rec_first" = false ] && echo ","
  echo -n "    {\"path\": \"streams/\", \"reason\": \"Runtime HLS segments and audio files\", \"priority\": \"high\"}"
  rec_first=false
fi

# Check node_modules
if [ -d "node_modules/" ]; then
  [ "$rec_first" = false ] && echo ","
  echo -n "    {\"path\": \"node_modules/\", \"reason\": \"Dependencies (managed by package.json)\", \"priority\": \"high\"}"
  rec_first=false
fi

# Check for other project directories that aren't part of current project
for dir in animation-server/ frontend/ tools/ vps-setup/ exported-layers/ data/ public/; do
  if [ -d "../$dir" ] || [[ "$(pwd)" != *"$dir"* ]]; then
    continue
  fi
done

# Check .git
if [ -d ".git/" ]; then
  gitsize=$(du -sm .git/ 2>/dev/null | cut -f1)
  if [ "$gitsize" -gt 50 ]; then
    [ "$rec_first" = false ] && echo ","
    echo -n "    {\"path\": \".git/\", \"reason\": \"Large git history ($gitsize MB)\", \"priority\": \"medium\"}"
    rec_first=false
  fi
fi

echo ""
echo "  ]"
echo "}"
