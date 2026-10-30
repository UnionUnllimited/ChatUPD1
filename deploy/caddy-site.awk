# Finds the top-level Caddyfile site block that serves `dom` and, in insert mode,
# prints the Caddyfile with the lines from `snip` placed right after that block's
# opening line. Site addresses may use {$VAR} / {$VAR:default}; values come from
# `envf` (KEY=VALUE lines, e.g. the Caddy container's environment).
#   awk -v dom=example.com -v envf=env.txt -v mode=find   -f caddy-site.awk Caddyfile   # exit 0 if found
#   awk -v dom=example.com -v envf=env.txt -v mode=insert -v snip=s.txt -f caddy-site.awk Caddyfile
# Exits with 3 when no site block serves the domain.
BEGIN {
  while ((getline l < envf) > 0) { i = index(l, "="); if (i) env[substr(l, 1, i - 1)] = substr(l, i + 1) }
  if (mode == "insert") while ((getline l < snip) > 0) block = block l "\n"
  depth = 0; found = 0
}

function serves(line,    addr, tok, def, j, val, n, parts, k, a) {
  addr = line
  sub(/\{[ \t]*$/, "", addr)
  while (match(addr, /\{\$[A-Za-z0-9_]+(:[^}]*)?\}/)) {
    tok = substr(addr, RSTART + 2, RLENGTH - 3); def = ""
    j = index(tok, ":"); if (j) { def = substr(tok, j + 1); tok = substr(tok, 1, j - 1) }
    val = (tok in env) ? env[tok] : def
    addr = substr(addr, 1, RSTART - 1) val substr(addr, RSTART + RLENGTH)
  }
  n = split(addr, parts, /[ ,\t]+/)
  for (k = 1; k <= n; k++) {
    a = tolower(parts[k])
    sub(/^https?:\/\//, "", a); sub(/\/.*$/, "", a); sub(/:[0-9]+$/, "", a)
    if (a != "" && a == tolower(dom)) return 1
  }
  return 0
}

{
  line = $0
  # A site block opens at depth 0 with "... {"; skip the global options block "{",
  # snippets "(name) {" and named routes "&(name) {".
  if (!found && depth == 0 && line ~ /\{[ \t]*$/ && line !~ /^[ \t]*\{[ \t]*$/ && line !~ /^[ \t]*&?\(/ && serves(line)) {
    found = 1
    if (mode == "find") exit 0
    print line
    printf "%s", block
  } else if (mode == "insert") {
    print line
  }
  t = line
  gsub(/"[^"]*"/, "", t)
  sub(/(^|[ \t])#.*$/, "", t)
  depth += gsub(/\{/, "{", t) - gsub(/\}/, "}", t)
}

END { exit found ? 0 : 3 }
