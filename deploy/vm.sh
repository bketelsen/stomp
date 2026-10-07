#!/usr/bin/env bash
# Run stomp in a local Incus VM (Debian 13, 4 vCPU, 8 GiB, 30 GiB disk).
#
#   deploy/vm.sh create            create and provision the VM; safe to re-run
#   deploy/vm.sh update [--apply]  say what an update does; --apply pushes this working tree, runs
#                                  npm ci and npm run build in the VM, copies ~/.config/stomp in,
#                                  installs the unit, restarts stomp
#   deploy/vm.sh config            copy ~/.config/stomp into the VM (no secrets live there), restart stomp
#   deploy/vm.sh open              open stomp in your browser with its API token, which the browser keeps;
#                                  once per browser
#   deploy/vm.sh login <provider>  github-copilot | openai | anthropic, as the VM's stomp user; you
#                                  finish the flow in your browser (paste the final redirect URL back)
#   deploy/vm.sh login github      gh's device flow for the stomp user; git then pushes through gh
#   deploy/vm.sh secret NAME       read a value silently (e.g. TYPESAFE_API_KEY) into the VM's ~/.local/share/stomp/env
#                                  and restart stomp; the value is never echoed or stored on this machine
#   deploy/vm.sh status | logs | shell
#   deploy/vm.sh destroy --yes
#
# Inside the VM stomp runs as the `stomp` user from ~/stomp, as the user unit deploy/stomp.service,
# bound to 127.0.0.1:7310. On the desktop, http://127.0.0.1:7311 reaches it through a systemd socket
# (see web()). Incus proxy devices can't do it: on VMs they are NAT-only, which would need stomp
# listening on the VM's own address.
# Credentials are made by `login` inside the VM and never leave it; nothing here copies or prints them.
# shellcheck disable=SC2016 # commands for the VM are single-quoted on purpose
set -euo pipefail

name=${STOMP_VM:-stomp-dev}
vm=local:$name # never the current remote, whatever it is
node=24.19.0
repo=$(cd "$(dirname "$0")/.." && pwd)

in_vm() { incus exec "$vm" -- "$@"; }
as_stomp() { incus exec "$vm" -- runuser -l stomp -c "$1"; }

# The working tree as git sees it: tracked and untracked files, less ignored and deleted ones.
tree() {
  git -C "$repo" ls-files -z --cached --others --exclude-standard --deduplicate |
    grep -zvE '(^|/)(node_modules|dist)/|^spike/[^/]+/(data|tmp|out)/|\.sqlite' |
    while IFS= read -r -d '' f; do [ -e "$repo/$f" ] && printf '%s\0' "$f"; done
}

net() {
  # STOMP_VM_CHECK adds URLs to check, such as a local model server's /v1/models.
  in_vm bash -c 'for url in '"${STOMP_VM_CHECK:-}"' https://github.com https://api.githubcopilot.com \
      https://chatgpt.com https://api.anthropic.com; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" || true)
    if [ "$code" = 000 ]; then echo "  FAIL  $url"; else echo "  ok    $url ($code)"; fi
  done'
}

create() {
  if ! incus info "$vm" >/dev/null 2>&1; then
    incus launch images:debian/13 "$vm" --vm -c limits.cpu=4 -c limits.memory=8GiB -d root,size=30GiB
  fi
  [ "$(incus info "$vm" | awk '/^Status:/ {print $2}')" = RUNNING ] || incus start "$vm"
  echo "waiting for the VM to boot"
  for _ in $(seq 60); do in_vm true 2>/dev/null && break; sleep 2; done
  in_vm systemctl is-system-running --wait >/dev/null || true

  in_vm bash -euo pipefail -s -- "$node" <<'EOF'
export DEBIAN_FRONTEND=noninteractive
if [ ! -f /etc/apt/sources.list.d/mise.list ]; then
  apt-get update -qq && apt-get install -yqq curl ca-certificates
  install -dm 755 /etc/apt/keyrings
  curl -fsSL https://mise.jdx.dev/gpg-key.pub -o /etc/apt/keyrings/mise.asc
  echo "deb [signed-by=/etc/apt/keyrings/mise.asc] https://mise.jdx.dev/deb stable main" >/etc/apt/sources.list.d/mise.list
fi
if [ ! -f /etc/apt/sources.list.d/github-cli.list ]; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/github-cli.gpg
  echo "deb [signed-by=/etc/apt/keyrings/github-cli.gpg] https://cli.github.com/packages stable main" >/etc/apt/sources.list.d/github-cli.list
fi
apt-get update -qq
apt-get install -yqq git curl ca-certificates build-essential ripgrep jq unzip socat mise gh procps file
id stomp >/dev/null 2>&1 || useradd -m -s /bin/bash stomp
# Homebrew in its standard Linux prefix, owned by stomp (who has no sudo), so agents can `brew install` what they need.
if [ ! -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
  install -d -o stomp -g stomp /home/linuxbrew /home/linuxbrew/.linuxbrew
  runuser -l stomp -c 'git clone -q --depth 1 https://github.com/Homebrew/brew /home/linuxbrew/.linuxbrew/Homebrew
    mkdir -p /home/linuxbrew/.linuxbrew/bin && ln -sf ../Homebrew/bin/brew /home/linuxbrew/.linuxbrew/bin/brew
    /home/linuxbrew/.linuxbrew/bin/brew update --force --quiet'
fi
loginctl enable-linger stomp
grep -q 'mise/shims' ~stomp/.profile || cat >>~stomp/.profile <<'PROFILE'
# deploy/vm.sh: mise's tools (node) on PATH, and the user manager for systemctl --user.
export PATH="$HOME/.local/share/mise/shims:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
PROFILE
# shellcheck disable=SC2016 # the line is written to .profile unexpanded
grep -q linuxbrew ~stomp/.profile || echo 'export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"' >>~stomp/.profile
runuser -l stomp -c "mise use -g -q node@$1"
EOF
  # Agents' commits: the desktop user's git identity, marked as coming from stomp.
  as_stomp "git config --global user.name $(printf %q "$(git config --global user.name) (stomp)"); git config --global user.email $(printf %q "$(git config --global user.email)")"
  as_stomp 'echo "node $(node --version), npm $(npm --version)"'
  echo "network from $name:"; net
  web
  echo "next: deploy/vm.sh config; deploy/vm.sh update --apply; deploy/vm.sh login <provider>"
}

# The desktop end: systemd listens on 127.0.0.1:7311 and hands each connection to
# `incus exec ... socat` into the VM's 127.0.0.1:7310. Nothing runs until a connection arrives.
web() {
  local d=~/.config/systemd/user
  mkdir -p "$d"
  cat >"$d/$name-web.socket" <<EOF
[Unit]
Description=stomp in the $name VM at http://127.0.0.1:7311
[Socket]
ListenStream=127.0.0.1:7311
Accept=yes
[Install]
WantedBy=sockets.target
EOF
  cat >"$d/$name-web@.service" <<EOF
[Unit]
Description=A connection to stomp in the $name VM
CollectMode=inactive-or-failed
[Service]
ExecStart=$(command -v incus) exec $vm -- socat STDIO TCP:127.0.0.1:7310
StandardInput=socket
EOF
  systemctl --user daemon-reload
  systemctl --user enable -q "$name-web.socket"
  systemctl --user restart "$name-web.socket"
}

# ~/.config/stomp over the VM's copy, less git and secrets.
push_config() {
  [ -d ~/.config/stomp ] || { echo "no ~/.config/stomp here; start from: cp -r $repo/examples/home ~/.config/stomp" >&2; exit 1; }
  tar -C ~/.config/stomp --exclude=.git --exclude=credentials.json --exclude='.env*' -cz . |
    as_stomp 'mkdir -p ~/.config/stomp && tar -xzv -C ~/.config/stomp'
}

update() {
  local rev size deployed
  rev="$(git -C "$repo" rev-parse --abbrev-ref HEAD)@$(git -C "$repo" rev-parse --short HEAD)"
  rev+=" +$(git -C "$repo" status --porcelain | wc -l) uncommitted"
  size=$(tree | tar -C "$repo" --null -T - -cz | wc -c)
  deployed=$(as_stomp 'cat ~/stomp/DEPLOYED 2>/dev/null' || true)
  echo "update $name from $repo"
  echo "  now:  ${deployed:-nothing deployed}"
  echo "  push: $(tree | tr -cd '\0' | wc -c) files ($((size / 1024)) KiB gz) from $rev"
  echo "  then: npm ci and npm run build in ~stomp/stomp.next, copy ~/.config/stomp in, swap the build in"
  echo "        as ~stomp/stomp (the old one stays as ~stomp/stomp.prev), install deploy/stomp.service as a"
  echo "        user unit, restart stomp"
  if [ "${1:-}" != --apply ]; then echo "dry run: nothing changed; re-run with --apply"; return; fi

  tree | tar -C "$repo" --null -T - -cz |
    as_stomp 'rm -rf ~/stomp.next && mkdir ~/stomp.next && tar -xz -C ~/stomp.next'
  as_stomp "set -e; cd ~/stomp.next; npm ci --no-audit --no-fund; npm run build
    echo $(printf %q "$rev, pushed $(date -Iseconds)") >DEPLOYED"
  # After the build, so a failed one leaves the old code with the old config.
  push_config
  as_stomp "set -e; rm -rf stomp.prev; [ ! -d stomp ] || mv stomp stomp.prev; mv stomp.next stomp
    mkdir -p ~/.config/systemd/user; cp stomp/deploy/stomp.service ~/.config/systemd/user/
    systemctl --user daemon-reload; systemctl --user enable -q stomp; systemctl --user restart stomp"
  sleep 3
  status
}

status() {
  incus list local: "^$name\$" -c ns4 -f compact
  as_stomp 'cat ~/stomp/DEPLOYED 2>/dev/null; systemctl --user --no-pager status stomp | head -n 12' || true
  echo "desktop: $name-web.socket $(systemctl --user is-active "$name-web.socket" || true)," \
    "http://127.0.0.1:7311/ -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:7311/ || true)"
}

case ${1:-} in
  create) create ;;
  update) update "${2:-}" ;;
  config)
    push_config
    as_stomp 'systemctl --user try-restart stomp 2>/dev/null || true'
    ;;
  open)
    # In the fragment, which never reaches a server; the page keeps the token and takes it out of the address bar.
    token=$(as_stomp 'cat ~/.local/share/stomp/token') || { echo "no token yet: stomp makes one when it first starts" >&2; exit 1; }
    xdg-open "http://127.0.0.1:7311/#token=$token"
    ;;
  login)
    case ${2:-} in
      github-copilot | openai | anthropic) incus exec -t "$vm" -- runuser -l stomp -c "cd ~/stomp && npm run login -- $2" ;;
      github) incus exec -t "$vm" -- runuser -l stomp -c 'gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git && gh auth status' ;;
      *) echo "usage: $0 login github-copilot|openai|anthropic|github" >&2; exit 2 ;;
    esac
    ;;
  secret)
    [[ ${2:-} =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "usage: $0 secret NAME   (e.g. TYPESAFE_API_KEY)" >&2; exit 2; }
    read -rsp "$2: " value && echo
    [ -n "$value" ] || { echo "empty; nothing changed" >&2; exit 1; }
    # The value travels on stdin, never on a command line.
    printf '%s\n' "$value" | as_stomp "set -e; f=~/.local/share/stomp/env; mkdir -p ~/.local/share/stomp; touch \$f; chmod 600 \$f
      v=\$(cat); grep -v '^$2=' \$f >\$f.new || true; printf '%s=%s\n' '$2' \"\$v\" >>\$f.new; mv \$f.new \$f; chmod 600 \$f
      cp ~/stomp/deploy/stomp.service ~/.config/systemd/user/; systemctl --user daemon-reload; systemctl --user try-restart stomp"
    echo "saved $2 in $name and restarted stomp"
    ;;
  status) status ;;
  logs) incus exec "$vm" -- runuser -l stomp -c 'journalctl --user -u stomp -n 100 -f' ;;
  shell) incus exec -t "$vm" -- su -l stomp ;;
  destroy)
    [ "${2:-}" = --yes ] || { echo "this deletes $name and everything in it, credentials included; re-run with --yes" >&2; exit 1; }
    systemctl --user disable -q --now "$name-web.socket" || true
    rm -f ~/.config/systemd/user/"$name"-web.socket ~/.config/systemd/user/"$name"-web@.service
    systemctl --user daemon-reload
    incus delete --force "$vm"
    ;;
  *) sed -n '2,/^# shellcheck/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2 ;;
esac
