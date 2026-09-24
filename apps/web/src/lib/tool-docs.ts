/**
 * Per-tool usage documentation content (see Savitura/Savitools#146).
 *
 * Every tool page on the site links to its `/docs/<slug>` page, and the
 * `/docs` index lists all ten. Each entry is kept in a consistent format:
 * overview → prerequisites → setup → usage steps → troubleshooting, so the
 * documentation is uniform in tone and structure.
 */

export interface ToolDocs {
  slug: string;
  name: string;
  href: string;
  tagline: string;
  overview: string[];
  prerequisites: string[];
  setup: string[];
  usage: { title: string; steps: string[] }[];
  troubleshooting: { issue: string; cause: string; fix: string }[];
}

export const toolDocs: ToolDocs[] = [
  {
    slug: 'inspector',
    name: 'Transaction Inspector',
    href: '/inspector',
    tagline: 'Decode any transaction hash, Stellar address, or raw XDR into a human-readable breakdown.',
    overview: [
      'The Transaction Inspector takes a Stellar transaction hash, a public key (G…), or a base64 XDR envelope and turns it into a readable breakdown: source account, sequence number, fees, memo, time bounds, and every operation with its result code and ledger effects.',
      'It is the fastest way to answer “what did this transaction actually do?” without scanning raw Horizon JSON.',
    ],
    prerequisites: [
      'No account required for public lookups.',
      'A transaction hash (64 hex chars), a Stellar public key, or a base64 XDR envelope.',
      'Network access to Horizon (testnet by default, mainnet available via the network toggle).',
    ],
    setup: [
      'Open the Transaction Inspector from the home page or go directly to /inspector.',
      'Optionally switch the network toggle between testnet and mainnet to match where the data lives.',
    ],
    usage: [
      {
        title: 'Inspect a transaction hash',
        steps: [
          'Paste a 64-character transaction hash into the search box.',
          'Click Inspect (or press Enter). The hash type is detected automatically.',
          'Review the header card: success/failure badge, source account, fees, memo, and time bounds.',
          'Expand each operation card to see fields, result codes, and ledger effects.',
          'Click “Show raw Horizon JSON” to inspect the un-decoded payload.',
          'Use “Inspect in Composer” to rebuild a similar transaction from the decoded operations.',
        ],
      },
      {
        title: 'Look up an account timeline',
        steps: [
          'Paste a Stellar public key (G…) into the search box.',
          'The inspector returns the last 20 transactions for that account.',
          'Click any row to jump into the full breakdown for that transaction.',
        ],
      },
      {
        title: 'Decode raw XDR',
        steps: [
          'Paste a base64 XDR envelope (usually a long string ending in =) into the search box.',
          'The inspector decodes it offline — no Horizon call is made.',
          'Results show the unsigned envelope’s operations, source, and signature count.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: '“Transaction not found on testnet”',
        cause: 'The hash is from a different network, or the transaction is very recent and not yet indexed.',
        fix: 'Switch the network toggle to mainnet if the transaction was submitted there, or wait a few seconds and retry.',
      },
      {
        issue: '“Unrecognised input”',
        cause: 'The pasted value is neither a 64-hex hash, a G… public key, nor a base64 XDR string.',
        fix: 'Check for typos or stray whitespace. Hashes are exactly 64 hex characters.',
      },
      {
        issue: 'No operations shown',
        cause: 'XDR decoded offline has no result codes or effects — those only exist after submission.',
        fix: 'This is expected for decoded envelopes. Result codes appear for transactions fetched by hash.',
      },
    ],
  },
  {
    slug: 'sandbox',
    name: 'Wallet Sandbox',
    href: '/sandbox',
    tagline: 'Generate testnet keypairs, fund them via Friendbot, and send test payments.',
    overview: [
      'The Wallet Sandbox creates throwaway testnet keypairs, funds them with Friendbot, inspects their balances/signers/flags, and sends test payments — all without leaving the browser.',
      'It is the fastest way to get a funded Stellar account for experimenting with the other tools.',
    ],
    prerequisites: [
      'Testnet network selected (sandbox features are disabled on mainnet).',
      'A running API server so Friendbot funding and payment submission work.',
      'A destination public key if you want to send payments.',
    ],
    setup: [
      'Open the Wallet Sandbox from the home page or go directly to /sandbox.',
      'Confirm the network toggle reads testnet — the sandbox is testnet-only for safety.',
    ],
    usage: [
      {
        title: 'Generate and fund a keypair',
        steps: [
          'Click “Generate Keypair”. A fresh public/secret pair appears.',
          'Copy the public key (safe to share) and reveal the secret key to copy it (keep it private).',
          'Click “Fund on Testnet” to receive 10,000 testnet XLM from Friendbot.',
          'Watch the confirmation — a link to the funding transaction on Stellar Expert is provided.',
        ],
      },
      {
        title: 'Inspect an account',
        steps: [
          'After funding, the account inspector shows the sequence number, balances, signers, thresholds, and flags.',
          'You can also paste any testnet public key into the inspector to view its details.',
        ],
      },
      {
        title: 'Send a test payment',
        steps: [
          'Paste the sender’s secret key (S…) into “From Secret Key”.',
          'Enter the destination public key (G…).',
          'Choose the asset (XLM or CODE:ISSUER) and amount, then optionally add a memo.',
          'Click “Send Payment” and review the result: transaction hash, fee, and result code.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: '“Sandbox features are disabled on mainnet”',
        cause: 'The network toggle is set to mainnet.',
        fix: 'Switch to testnet. Never generate or fund real-mainnet keys in the sandbox.',
      },
      {
        issue: 'Funding fails with a timeout',
        cause: 'Friendbot is rate-limited or the API server cannot reach it.',
        fix: 'Wait a few minutes and retry. If you are self-hosting, check that the API has internet access.',
      },
      {
        issue: '“Invalid source secret key” when sending',
        cause: 'The pasted secret is malformed or truncated.',
        fix: 'Regenerate the keypair and copy the full secret, or re-paste it carefully.',
      },
    ],
  },
  {
    slug: 'composer',
    name: 'Transaction Composer',
    href: '/composer',
    tagline: 'Build multi-operation Stellar transactions visually — no SDK required.',
    overview: [
      'The Composer is a visual builder for Stellar transactions. Add operations (payments, trustlines, offers, path payments, and more), configure the source account and fee, and generate the unsigned XDR.',
      'The result can be signed with a browser wallet (e.g. Freighter) or locally with a secret key, simulated to check for errors, and submitted through the active network profile.',
    ],
    prerequisites: [
      'A funded Stellar account (public key + sequence number).',
      'The Wallet Sandbox can generate and fund one in seconds.',
      'An understanding of what you want the transaction to do (operations, assets, amounts).',
    ],
    setup: [
      'Open the Composer from the home page or go directly to /composer.',
      'Pick the network (testnet or mainnet) that matches your account.',
    ],
    usage: [
      {
        title: 'Build a transaction',
        steps: [
          'Enter the source account public key and its current sequence number.',
          'Click “Add Operation” and pick a type (e.g. Payment, Change Trust, Manage Sell Offer).',
          'Fill in the operation fields. Assets can be native XLM or CODE:ISSUER.',
          'Repeat to add multiple operations — the Composer supports mixed operation types.',
          'Set the fee and optional memo, then click “Build” to generate the XDR envelope.',
        ],
      },
      {
        title: 'Sign and submit',
        steps: [
          'Open the sign step and choose how to sign: a browser wallet (Freighter) or the source secret key.',
          'Wallet mode connects to the extension, shows the connected public key, and signs the XDR with the active network passphrase — no secret key is ever requested. Account or network mismatches are rejected before signing.',
          'Secret-key mode signs locally in the browser; the secret is zeroed from memory after use.',
          'Submission always goes through the active network profile — built-in or custom Horizon URL.',
          'Simulate first to catch errors before submitting, then submit and view the result hash.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: '“Invalid source account sequence”',
        cause: 'The sequence number does not match the account’s current sequence.',
        fix: 'Look up the account in the Wallet Sandbox inspector or Horizon and use the latest sequence.',
      },
      {
        issue: 'Simulation reports tx_bad_seq',
        cause: 'The account was used between building and submitting.',
        fix: 'Rebuild the transaction with the fresh sequence number.',
      },
      {
        issue: 'Invalid asset format',
        cause: 'Assets must be “XLM” or “CODE:ISSUER”.',
        fix: 'Use the exact 12-character-or-less asset code and full issuer public key.',
      },
    ],
  },
  {
    slug: 'simulator',
    name: 'Payment Simulator',
    href: '/simulator',
    tagline: 'Find path payment routes and preview fees before you send.',
    overview: [
      'The Payment Simulator finds path-payment routes between any two assets on Stellar, previews the hops, exchange rate, and estimated fee, and can estimate the effect of slippage.',
      'Use it before sending a cross-asset payment to know exactly what the recipient will receive.',
    ],
    prerequisites: [
      'The asset codes and issuers you want to trade between.',
      'An amount to simulate.',
      'A destination public key if you want to preview a real route (optional for route-only queries).',
    ],
    setup: [
      'Open the Payment Simulator from the home page or go directly to /simulator.',
      'Choose strict send (you send a fixed amount) or strict receive (recipient gets a fixed amount).',
    ],
    usage: [
      {
        title: 'Find a route',
        steps: [
          'Select the source asset (native XLM or CODE:ISSUER) and the destination asset.',
          'Enter the amount and click “Find Paths”.',
          'Review the returned paths — each shows hops, the effective rate, and estimated fee.',
          'Pick a path and use the slippage estimator to see the guaranteed minimum/maximum.',
        ],
      },
      {
        title: 'Check the order book',
        steps: [
          'Open the DEX Order Book from the simulator page link.',
          'Pick a trading pair to see live spread, mid price, and liquidity depth.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: 'No paths found',
        cause: 'There is no available order book path between the two assets.',
        fix: 'Try a different pair, or use a path with intermediate hops via a popular asset like XLM or USDC.',
      },
      {
        issue: '400 Invalid asset parameters',
        cause: 'An asset code/issuer combination is malformed.',
        fix: 'Use CODE:ISSUER format with a valid issuer public key.',
      },
    ],
  },
  {
    slug: 'webhooks',
    name: 'Webhook Tester',
    href: '/webhooks',
    tagline: 'Fire sample CrowdPay and Fluxa webhook payloads at your endpoint and inspect the response.',
    overview: [
      'The Webhook Tester sends realistic CrowdPay and Fluxa event payloads to your own endpoint so you can see exactly what your receiver gets, how fast, and what it returns.',
      'Every send is recorded in history and can be replayed with one click.',
    ],
    prerequisites: [
      'A running webhook endpoint (a URL that accepts POST requests).',
      'A local tunnel (e.g. ngrok) if your endpoint runs on your machine.',
    ],
    setup: [
      'Open the Webhook Tester from the home page or go directly to /webhooks.',
      'Make sure your endpoint is reachable from the API server (not just localhost).',
    ],
    usage: [
      {
        title: 'Send a test payload',
        steps: [
          'Enter your endpoint URL.',
          'Pick a provider (CrowdPay or Fluxa) and an event type from the template list.',
          'Optionally customise the payload JSON and add a signing secret.',
          'Click “Send” and review the status code, response headers/body, and latency.',
        ],
      },
      {
        title: 'Replay a delivery',
        steps: [
          'Open the history panel to see past sends.',
          'Click “Replay” on any entry to re-fire the identical payload.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: 'Connection refused / ECONNREFUSED',
        cause: 'The endpoint is not reachable from the API server (e.g. only bound to localhost).',
        fix: 'Expose the endpoint publicly or use a tunnel such as ngrok.',
      },
      {
        issue: 'Status code 4xx from my endpoint',
        cause: 'Your receiver rejected the payload shape or signature.',
        fix: 'Inspect the response body in the tester and adjust your handler.',
      },
    ],
  },
  {
    slug: 'monitor',
    name: 'Ledger Monitor',
    href: '/monitor',
    tagline: 'Watch a Stellar address or contract for live activity and set alert rules.',
    overview: [
      'The Ledger Monitor streams live activity for the accounts and contracts you choose — transactions, payments, and contract events — over a real-time connection.',
      'Each watch can have alert rules (e.g. amount received ≥ threshold, asset received, any activity) delivered in-app, by email, or to your webhook.',
    ],
    prerequisites: [
      'A registered account — the Monitor is authenticated.',
      'A Stellar public key or contract ID you want to watch.',
      'A funded testnet account if you want payment alerts to fire in practice.',
    ],
    setup: [
      'Open the Ledger Monitor from the home page or go directly to /monitor.',
      'Log in if prompted — watches are tied to your account.',
      'Make sure the API server and its Redis/Postgres services are running.',
    ],
    usage: [
      {
        title: 'Create a watch',
        steps: [
          'Click the “Add watch” (+) button.',
          'Enter the public key or contract ID, give it a label, and pick the event types (transaction, payment, contract).',
          'Add alert rules: e.g. “notify me when a payment of 100 XLM or more is received”.',
          'Save the watch — a live stream connects and event cards start appearing in the feed.',
        ],
      },
      {
        title: 'Review events and alerts',
        steps: [
          'Click a watch in the sidebar to see its live feed.',
          'Use “Pause scroll” to freeze the feed while you inspect a card.',
          'Open the alert panel to see fired alerts, delivery status, and retry/resend options.',
        ],
      },
      {
        title: 'Search events',
        steps: [
          'Use the search box in the watch header to filter the feed by transaction hash, account, or asset.',
          'The feed queries the same search endpoint the CSV export uses, so results stay consistent.',
          'Clear the search to return to the full live feed.',
        ],
      },
      {
        title: 'Export event history',
        steps: [
          'Click “Export CSV” in the watch header to download the event history as a spreadsheet-ready file.',
          'The export applies the same filters as the on-screen feed — including any active search query — and is capped at 10,000 rows.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: 'Stream disconnected / reconnect loop',
        cause: 'The WebSocket connection dropped (network change, server restart).',
        fix: 'Click “Reconnect”. The monitor resumes from the last processed cursor without duplicates.',
      },
      {
        issue: 'No events for my watch',
        cause: 'The watched address simply has no activity yet, or event types are too narrow.',
        fix: 'Send a test payment from the Wallet Sandbox to the watched address, or widen the event types.',
      },
      {
        issue: 'Watch status shows error',
        cause: 'Horizon or the RPC endpoint is unreachable from the API server.',
        fix: 'Check the last error on the watch card and verify network connectivity.',
      },
    ],
  },
  {
    slug: 'playground',
    name: 'API Playground',
    href: '/playground',
    tagline: 'Explore and test the Fluxa and CrowdPay APIs interactively.',
    overview: [
      'The API Playground loads the Fluxa or CrowdPay OpenAPI spec, lets you browse endpoints, build requests with path/query params and a JSON body, and sends them through the SaviTools proxy with your stored API keys.',
      'Every response is shown with status, headers, latency, and a copy-paste cURL equivalent.',
    ],
    prerequisites: [
      'A registered account — the Playground is authenticated.',
      'A Fluxa and/or CrowdPay API key saved in the key manager (optional for public endpoints).',
    ],
    setup: [
      'Open the API Playground from the home page or go directly to /playground.',
      'Choose the provider (Fluxa or CrowdPay) from the selector.',
      'Use the Key Manager to store your API keys — they are masked and never returned in full.',
    ],
    usage: [
      {
        title: 'Send a request',
        steps: [
          'Browse the endpoint list in the sidebar and click one to select it.',
          'Fill in path parameters, query parameters, and the JSON body as required.',
          'Toggle “Use auth” to attach your stored API key to the request.',
          'Click “Send” and review the response panel: status, headers, body, latency.',
          'Use “Copy cURL” to reproduce the call outside the browser.',
        ],
      },
      {
        title: 'Review history',
        steps: [
          'Past requests appear in the history section below the workspace.',
          'Re-run any previous request by selecting it.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: '401 from the proxy',
        cause: 'The provider rejected the API key, or no key is attached.',
        fix: 'Save a valid key in the Key Manager and ensure “Use auth” is on.',
      },
      {
        issue: 'Spec fails to load',
        cause: 'The provider spec URL is unreachable or the API server is down.',
        fix: 'Retry, and check that the API server can reach the provider.',
      },
    ],
  },
  {
    slug: 'contracts',
    name: 'Contract Deploy Helper',
    href: '/contracts',
    tagline: 'Upload and deploy Soroban WASM files to testnet from the browser.',
    overview: [
      'The Contract Deploy Helper uploads a compiled Soroban contract (.wasm), deploys it to testnet, and keeps a local history of your contracts.',
      'Once deployed, you can invoke contract functions with JSON arguments and inspect the response right in the tool.',
    ],
    prerequisites: [
      'A compiled Soroban .wasm file.',
      'The API server’s deployer account funded on testnet (DEPLOYER_SECRET_KEY configured).',
      'Constructor arguments (if any) as a JSON array.',
    ],
    setup: [
      'Open the Contract Deployer from the home page or go directly to /contracts.',
      'Confirm the API server has DEPLOYER_SECRET_KEY set to a funded testnet account.',
    ],
    usage: [
      {
        title: 'Deploy a contract',
        steps: [
          'Drag a .wasm file into the upload zone (or click to browse).',
          'Add constructor arguments as a JSON array if the contract requires them.',
          'Click “Deploy to Testnet”. Watch the progress text and wait for the result.',
          'The new contract ID appears in your history with a Stellar Expert link.',
        ],
      },
      {
        title: 'Invoke a function',
        steps: [
          'Select a contract from the history list.',
          'Enter the function name and a JSON array of arguments.',
          'Click “Invoke” and read the raw response.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: '“Please upload a valid .wasm file”',
        cause: 'The file does not have a .wasm extension.',
        fix: 'Rename the compiled artifact with the .wasm extension and retry.',
      },
      {
        issue: 'Deployment fails with an account error',
        cause: 'The deployer account is unfunded or DEPLOYER_SECRET_KEY is not configured.',
        fix: 'Fund the deployer on testnet and verify the API environment variable.',
      },
      {
        issue: '“Invalid JSON” in arguments',
        cause: 'The args field is not valid JSON or not an array.',
        fix: 'Use a JSON array, e.g. ["GAIH3...", 1234567890].',
      },
    ],
  },
  {
    slug: 'sdk',
    name: 'SDK Generator',
    href: '/sdk',
    tagline: 'Generate copy-paste client code (TypeScript, Python, Go, cURL) from Fluxa/CrowdPay endpoints.',
    overview: [
      'The SDK Generator produces ready-to-paste client code for the Fluxa and CrowdPay APIs in four languages: TypeScript, Python, Go, and cURL.',
      'Pick a spec and a language; the generator returns a full working snippet with install instructions.',
    ],
    prerequisites: [
      'The API server running (generation is server-side).',
      'An API key for the chosen provider when you actually use the generated code.',
    ],
    setup: [
      'Open the SDK Generator from the home page or go directly to /sdk.',
      'Ensure the API server is reachable on port 3001 (the generator calls /api/v1/sdkgen/generate).',
    ],
    usage: [
      {
        title: 'Generate code',
        steps: [
          'Select the API definition: Fluxa or CrowdPay.',
          'Choose a language tab: TypeScript, Python, Go, or cURL.',
          'Read the install command (npm/pip/go) and the generated snippet.',
          'Copy the code and replace API_KEY and variable placeholders with your values.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: '“Error connecting to backend”',
        cause: 'The API server is not running on port 3001.',
        fix: 'Start the API with npm run dev and reload the page.',
      },
      {
        issue: 'Generated code returns 401',
        cause: 'The API_KEY placeholder was not replaced with a real key.',
        fix: 'Save a valid key in the API Playground Key Manager and paste it into the snippet.',
      },
    ],
  },
  {
    slug: 'network',
    name: 'Network Status',
    href: '/network',
    tagline: 'Live Stellar network health: ledger close time, fee tracker, and Horizon latency.',
    overview: [
      'Network Status shows a live dashboard of Stellar network health: current ledger sequence, seconds since last close, Horizon latency, and fee metrics (base fee, P90 recommendation).',
      'A 60-minute base-fee history chart helps spot congestion trends.',
    ],
    prerequisites: [
      'Network access to Horizon (via the API server).',
      'No account required.',
    ],
    setup: [
      'Open Network Status from the home page or go directly to /network.',
      'Toggle between mainnet and testnet to compare both networks.',
    ],
    usage: [
      {
        title: 'Read the dashboard',
        steps: [
          'Check the four status cards: network, latest ledger, last close, and Horizon latency.',
          'Review the fee metrics card for the current base fee and the recommended (P90) fee.',
          'Use the ledger stats card to see the average close time.',
          'Watch the base-fee history chart for congestion trends over the last hour.',
        ],
      },
    ],
    troubleshooting: [
      {
        issue: '“Could not connect to Horizon”',
        cause: 'The API server cannot reach Horizon, or it is not running.',
        fix: 'Verify the API server is up and that STELLAR_HORIZON_URL is reachable.',
      },
      {
        issue: 'Empty history chart',
        cause: 'The dashboard only starts collecting after the first poll.',
        fix: 'Wait up to a minute — samples are collected on each refresh.',
      },
    ],
  },
];
