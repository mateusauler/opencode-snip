// Replicates opencode's permission prefix rules for saved approvals, which
// plugins cannot import (packages/core/src/shell/parse.ts and scan.ts).
// This module is the deletion target if opencode ever exports them.

// Allow-always must save the same prefix the shell tool saves, or the saved rule
// would only cover this exact command.
const ARITY: Record<string, number> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,
  docker: 2,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  npx: 2,
  nvm: 2,
  nx: 2,
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  python: 2,
  pyenv: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
}
const PREFIX_LENGTH = Math.max(...Object.values(ARITY))

function prefix(words: string[]) {
  for (let length = Math.min(words.length, PREFIX_LENGTH); length > 0; length--) {
    const arity = ARITY[words.slice(0, length).join(" ")]
    if (arity !== undefined) return words.slice(0, arity)
  }
  return words.slice(0, 1)
}

const NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*`
const ASSIGNMENT_WORD = new RegExp(`^${NAME}\\+?=`)
const OPERATOR = String.raw`\d*[<>]+[|&]?|&>>?`
const REDIRECT = new RegExp(`^(?:${OPERATOR})`)
const BARE_REDIRECT = new RegExp(`^(?:${OPERATOR})$`)

// Raw shell words, keeping quotes and escapes as written. Parentheses keep a
// value together and redirects become their own tokens.
function shellWords(command: string): string[] {
  const tokens: string[] = []
  let word = ""
  let quote: string | undefined
  let depth = 0
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === "\\" && quote !== "'") {
      word += char + (command[++index] ?? "")
      continue
    }
    if (quote) {
      word += char
      if (char === quote) quote = undefined
      continue
    }
    if (!depth && (char === "<" || char === ">" || (char === "&" && command[index + 1] === ">"))) {
      let operator = /^\d+$/.test(word) ? word : ""
      if (word && !operator) tokens.push(word)
      word = ""
      while (index < command.length && "<>&|".includes(command[index])) operator += command[index++]
      tokens.push(operator)
      index--
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "(") depth++
    else if (char === ")" && depth > 0) depth--
    else if (!depth && (char === " " || char === "\t" || char === "\n")) {
      if (word) tokens.push(word)
      word = ""
      continue
    }
    word += char
  }
  if (word) tokens.push(word)
  return tokens
}

// A redirect ends the prefix, and a leading redirect's target is skipped, like
// opencode's scanner. Leading assignments are dropped.
function commandWords(command: string): string[] {
  const words: string[] = []
  const tokens = shellWords(command)
  let started = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (REDIRECT.test(token)) {
      if (started) break
      if (BARE_REDIRECT.test(token)) index++
    } else if (started || !ASSIGNMENT_WORD.test(token)) {
      started = true
      words.push(token)
    }
  }
  return words
}

export function savePattern(command: string): string {
  return `${prefix(commandWords(command)).join(" ")} *`
}
