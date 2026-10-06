# Deploying stomp

stomp runs in a local Incus VM, `stomp-dev`, as the systemd user unit `stomp.service` of the VM's
`stomp` account. Inside the VM it listens on 127.0.0.1:7310. On the desktop, open
http://127.0.0.1:7311.

A systemd socket on the desktop (`stomp-dev-web.socket`) tunnels each connection through
`incus exec … socat`, because Incus proxy devices on VMs are NAT-only. Nothing runs while it's idle.

```sh
deploy/vm.sh create              # make and provision the VM; safe to re-run
deploy/vm.sh config              # copy ~/.config/stomp in (no secrets live there)
deploy/vm.sh update              # see what an update would do
deploy/vm.sh update --apply      # push this working tree, build, restart
deploy/vm.sh login <provider>    # github-copilot | openai | anthropic
deploy/vm.sh status | logs | shell
deploy/vm.sh destroy --yes       # also deletes the VM's credentials
```

- **Logins** run inside the VM, and the credentials never leave it. For openai and anthropic, the
  browser ends on a page that won't load; paste that page's URL back into the terminal.
- **Updates** build in `~stomp/stomp.next` and swap only on success, so a failed build leaves the old
  version running. The previous deploy stays in `~stomp/stomp.prev`.
- **Where things live:** state in `~stomp/.local/share/stomp`, code in `~stomp/stomp`.
