#!/bin/bash
echo "{"
echo "  \"directories\": ["
du -sm */ 2>/dev/null | sort -rn | head -10 | awk '{printf "    {\"path\": \"%s\", \"size_mb\": %d}%s\n", $2, $1, (NR<10?",":"")}'
echo "  ],"
echo "  \"file_counts\": {"
echo "    \"total\": $(find . -type f 2>/dev/null | wc -l),"
echo "    \"in_streams\": $(find streams/ -type f 2>/dev/null | wc -l),"
echo "    \"in_node_modules\": $(find node_modules/ -type f 2>/dev/null | wc -l),"
echo "    \"ts_files\": $(find . -name '*.ts' 2>/dev/null | wc -l),"
echo "    \"m3u8_files\": $(find . -name '*.m3u8' 2>/dev/null | wc -l)"
echo "  }"
echo "}"
