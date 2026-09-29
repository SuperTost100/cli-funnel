# Terms and limits

cli-funnel runs the official CLI on the user's own machine, signed in with the user's own account. It does not read tokens, replay sessions or call private endpoints. That is the same thing a terminal, an editor plugin or a desktop app such as T3 Code does.

That does not decide what each provider's terms allow. I have not verified current terms for all four vendors, and they change. Read them before you ship a product.

Points worth checking:

- Whether the plan is for one person. A consumer subscription used to serve many end users through your app is the most likely thing to break a plan's terms. Use [API keys](api-keys.md) for that.
- Whether automated or scripted use of the CLI is allowed on your plan, and what the rate limits are. Headless runs spend the same quota as interactive ones.
- Whether your users are signed in to their own accounts, on their own machines. That is the shape this package is built for.

## Things cli-funnel will not do

- It will not pass `claude --bare`. That flag disables subscription login.
- It will not extract or forward OAuth tokens between machines.
- It will not present one account's login to other people.

## Data

Prompts and file contents go to the vendor exactly as they would from the CLI. Some model entries in the CLIs carry data-retention notes, such as "no zero data retention". cli-funnel shows the name the CLI gives.
