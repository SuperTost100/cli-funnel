# Terms and limits

cli-funnel runs the official CLI on the user's own machine, signed in with the user's own account. It does not read tokens, replay sessions or call private endpoints. That is the same thing a terminal, an editor plugin or a desktop app such as T3 Code does.

That does not decide what each provider's terms allow. I have not verified current terms for all four vendors, and they change. Read them before you ship a product.

Points worth checking:

- Whether the plan is for one person. A consumer subscription used to serve many end users through your app is the most likely thing to break a plan's terms. Use [API keys](api-keys.md) for that.
- Whether automated or scripted use of the CLI is allowed on your plan, and what the rate limits are. Headless runs draw from the same quota as interactive ones, but not always at the same rate. On Claude Code, headless runs are reported to use the five-hour window faster: see [Subscription limits and the entry point](providers/claude.md#subscription-limits-and-the-entry-point).
- Whether your users are signed in to their own accounts, on their own machines. That is the shape this package is built for.

## Antigravity

A reply on Google's developer forum, from an account that speaks for the Antigravity team, lists "wrapping `agy -p` in third-party agent loops" among the uses that get an account suspended, and names the Agent Client Protocol as the way to let other apps drive Antigravity: [TOS clarification: is T3 Code's official Antigravity ACP agent permitted under the Antigravity terms of service?](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027), read on 2026-11-19. That is a report of a forum reply. It is not Google's published policy, and I could not check the terms themselves.

That is why the default Antigravity transport is `agy acp` and not one `agy --print` process per message. The `print` transport stays selectable (`providerOptions.antigravity.transport: "print"`), for older agy builds and for the options only it has, and it is the one the forum reply warns about. A `print` run is a script around `agy -p` in the sense of that reply. Use it with that in mind, and read the current terms before you ship a product on it.

`funnel.rateLimits("antigravity")` runs `agy --print=/usage`, a one-off command that starts no model turn.

## Things cli-funnel will not do

- It will not pass `claude --bare`. That flag disables subscription login.
- It will not extract or forward OAuth tokens between machines.
- It will not present one account's login to other people.

## Data

Prompts and file contents go to the vendor exactly as they would from the CLI. Some model entries in the CLIs carry data-retention notes, such as "no zero data retention". cli-funnel shows the name the CLI gives.
