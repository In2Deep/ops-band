# ops-band

A Claude Code mod that adds one row above your prompt:

```
workers: 2 out, longest 6m (Build the parser, Review the parser) | usage 41% | cap % [ 55 ]
```

- **workers**: how many subagents are out right now, how long the longest has been out, and what the first two are doing.
- **usage**: your weekly usage, as a percent.
- **cap %**: a box holding your usage cap. Type a number from 1 to 100, or `off`, and press Enter.
- **/cap**: the same from the prompt. `/cap` shows the cap and usage, `/cap 55` sets it, `/cap off` turns it off.

The row refreshes every 5 seconds.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install ops-band --marketplace In2Deep/ops-band
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter).

From a shell:

```
claude plugin install ops-band --marketplace In2Deep/ops-band
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `In2Deep/ops-band`, then Add plugin.

## What the cap does, and what it does not

The mod **records** your cap: it writes the number to `~/.claude/usage_cap` (for example `55`, or `off`). On its own it does not stop anything. It shows you the number and your usage side by side.

The `/cap` command and the box only accept a cap typed at your own prompt (or sent through Remote Control); a `/cap` that comes from anything else is refused. That guards the command, not the file: Claude's own file tools could still edit `~/.claude/usage_cap` unless you deny that. The setup below adds deny rules for it; treat those as a guard rail, not a lock.

To make Claude Code actually **stop at the cap**, you need a small hook that reads the same file. The next section sets that up for you.

## Optional: make the cap enforce itself

Paste this prompt into Claude Code and let it do the setup. Read what it proposes before you approve it.

```
Set up a weekly usage cap for Claude Code on this machine. Show me each file
before you write it and the settings change before you make it.

1. Status line script. Write ~/.claude/hooks/usage_statusline.py: it reads the
   JSON that Claude Code passes to a status line command on stdin and, when that
   JSON has a rate_limits block, saves {"rate_limits": <that block>} to
   ~/.claude/usage_rate_limits.json (write to a temporary file, then rename).
   It prints a short status line, for example the weekly percent used. If I
   already have a statusLine command in ~/.claude/settings.json, do not replace
   it: add the saving step to my existing script instead.

2. PreToolUse hook. Write ~/.claude/hooks/usage_cap.py: it reads the cap from
   ~/.claude/usage_cap (a whole percent from 1 to 100; a missing file, an empty
   file or the word "off" means no cap) and the usage from
   ~/.claude/usage_rate_limits.json (the highest used_percentage of any window
   except five_hour). When usage is at or above the cap it exits with code 2 and
   prints to stderr that the usage cap is reached, that work must stop now, and
   that only the person can lift the cap by editing ~/.claude/usage_cap or
   typing /cap. Otherwise, including when it cannot read a file, it exits 0
   (step 4 adds one more refusal).

3. Register both in ~/.claude/settings.json: the status line under
   "statusLine" (type "command", refreshInterval 60) and the hook under
   hooks.PreToolUse with a matcher that covers every tool. Keep everything
   already in that file.

4. Protect the cap file from Claude itself: in ~/.claude/settings.json add
   permission deny rules so the Edit and Write tools cannot change
   ~/.claude/usage_cap, and make the hook from step 2 also refuse (exit 2) any
   Bash command that names usage_cap, whatever the usage is. I set the cap
   myself with /cap.

5. Test the hook without waiting for real usage: run it by hand with a
   temporary HOME that holds a cap of 10 and a rate file at 50 percent (expect
   exit 2), then with the cap set to "off" (expect exit 0). Do not change my
   real cap file.
```

After that, `/cap 55` means: at 55% of the weekly allowance, every tool call is refused until you raise the cap or turn it off.

If the status line script is in place, the band reads the same saved figure the hook does. Without it, the band shows the usage figure of the current session.

## Optional: show a running job in the band

Any script of yours can put one more segment in the row while it runs. Write one line to `~/.claude/ops-band/job.status`:

```
<name> <stage> <epoch seconds when it started>
```

For example, in a shell script:

```
mkdir -p ~/.claude/ops-band
echo "deploy tests $(date +%s)" > ~/.claude/ops-band/job.status
# ... the work ...
rm -f ~/.claude/ops-band/job.status
```

The band then shows `| deploy: tests, 3m`. The name and the stage are one word each (no spaces). Remove the file when the job ends. A line older than 45 minutes is ignored.

## Files

- `hooks/register.tsx`: the mod.
- `types/index.d.ts`: the shape of what the band keeps between refreshes.
- `tests/cap.test.ts`: tests; run them with `claude plugin test <folder>`.

The mod reads `~/.claude/usage_cap`, `~/.claude/usage_rate_limits.json` and `~/.claude/ops-band/job.status`, and writes only `~/.claude/usage_cap`. It sends nothing anywhere.

## License

MIT No Attribution (MIT-0), by Brandon Hatch. Do anything you like with it: use it, change it, sell it. You don't have to credit me. If you build something with it, a mention is appreciated, and no hard feelings if not.
