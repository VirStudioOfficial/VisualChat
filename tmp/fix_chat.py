with open('/tmp/chat_clean.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

start_idx = None
end_idx = None
for i, line in enumerate(lines):
    if 'LARGE_FILE_LINE_THRESHOLD' in line:
        start_idx = i
    if start_idx is not None and '.join(\'\');' in line and i > start_idx:
        end_idx = i + 1
        break

if start_idx is not None and end_idx is not None:
    print(f"Replacing lines {start_idx} to {end_idx}")
    new_lines = [
        "                const fileBlocks =\n",
        "                    textFiles\n",
        "                        .map(\n",
        "                            f => {\n",
        "                                const content = f.content || '';\n",
        "                                return `\\n\\n` +\n",
        "                                    `[محتوای فایل: ${f.name || 'file'}]\\n` +\n",
        "                                    '```\\n' +\n",
        "                                    content +\n",
        "                                    '\\n```\\n' +\n",
        "                                    `[پایان محتوای فایل: ${f.name || 'file'}]`;\n",
        "                            }\n",
        "                        )\n",
        "                        .join('');\n"
    ]
    lines = lines[:start_idx] + new_lines + lines[end_idx:]
    with open('/tmp/chat_clean.js', 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print("Successfully replaced file injection block!")
else:
    print("Could not find start/end idx")
