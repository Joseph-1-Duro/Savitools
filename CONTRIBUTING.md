# Contributing to SaviTools

SaviTools uses [GrantFox](https://grantfox.xyz) to fund and coordinate open-source contributions. Contributors pick a funded issue, implement it, and submit a PR. One issue per contributor at a time.

---

## Quick Setup

### Prerequisites

- Node.js: 20+
- npm: 10+
- Docker: 24+

### Get running

1. Clone the repository:
   ```bash
   git clone https://github.com/Savitura/Savitools.git
   cd Savitools
   ```
2. Copy environment files and fill them out. See inline comments for required values:
   ```bash
   cp apps/api/.env.example apps/api/.env
   cp apps/web/.env.example apps/web/.env
   ```
   `apps/api/.env.example` documents every runtime-read variable. At startup the API validates its configuration (`apps/api/src/config/env-validation.ts`) and fails fast with an aggregated error for missing required URLs, non-HTTPS public URLs in production, placeholder auth/encryption secrets, and enabled-but-misconfigured features — so keep the two templates and the validator in sync when you add variables.
3. Start the entire local stack:
   ```bash
   make dev
   ```
4. Wait for `api` and `web` to become ready (check with `make logs`), then seed the database with test data:
   ```bash
   make seed
   ```

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| API | http://localhost:3001/api |
| Swagger docs | http://localhost:3001/api/docs |

Other useful commands:
- `make logs`: Tails logs for all running services
- `make reset`: Tears down all containers and named volumes, then restarts clean
- `make test`: Runs all test suites across the monorepo via Turborepo

---

## Picking Up an Issue

1. Find an open, unassigned issue in [GitHub Issues](https://github.com/Savitura/Savitools/issues)
2. Comment to claim it — wait for assignment before starting
3. Fork and branch off `main`: `feat/issue-<number>-short-description`
4. Stay current with `git rebase origin/main`

Read the full issue body before writing code. Every issue has an acceptance criteria checklist — that's what the PR needs to satisfy.

---

## Codebase Orientation

SaviTools is a Turborepo monorepo with two main directories:

- `apps/` — Contains applications that run independently.
  - `apps/api` — NestJS backend; one module per tool (e.g. `modules/inspector/`, `modules/wallet/`). Each module has a controller, service, and module file. Business logic lives in the service.
  - `apps/web` — Next.js 15 App Router frontend; one route folder per tool (e.g. `app/inspector/`, `app/sandbox/`).

Most issues touch one module in the API and one page in the web app. Read both the existing service stub and the page stub before making any changes — they usually have comments indicating what needs to be implemented.

---

## Working with AI Agents

AI coding assistants (Claude Code, Cursor, Copilot, etc.) are welcome. The issues are written with enough context to serve as effective prompts directly. You are responsible for everything in the PR.

### Effective patterns

**1. Read the stubs first**

Most SaviTools features have a placeholder stub already in place. Ask the agent to read them before writing:

```
Read these files first:
- apps/api/src/modules/simulator/simulator.service.ts
- apps/api/src/modules/simulator/simulator.controller.ts
- apps/web/src/app/composer/page.tsx

Then explain what currently exists and what the following issue requires.
Don't write any code yet.

[paste issue body]
```

**2. Paste the full issue verbatim**

The acceptance criteria are written to be directly checked against. Include the complete issue body.

**3. Show it an existing complete module as reference**

```
The inspector module at apps/api/src/modules/inspector/ is the most complete
reference implementation. Follow the same service/controller/module structure
for the new module.
```

**4. NestJS-specific prompt tips**

Tell the agent to:
- Register the new module in `apps/api/src/app.module.ts`
- Use `@Injectable()` on services, `@Controller()` on controllers
- Add `@ApiTags()` and `@ApiOperation()` decorators for Swagger
- Use the existing `@stellar/stellar-sdk` import style (check existing services)

**5. Next.js App Router tips**

Tell the agent:
- Pages are server components by default — add `'use client'` only when you need `useState`/`useEffect`
- Data fetching goes in server components or route handlers, not in `useEffect`
- Follow the layout/styling patterns in the existing pages (Tailwind + shadcn/ui)

**6. Review every diff**

Agents commonly:
- Forget to add the module to `app.module.ts` imports
- Miss the `@Module({ providers, controllers, exports })` decorator
- Use `fetch` in a server component without proper error handling
- Add Tailwind classes that don't exist in the project config

Run `npm run build` to catch TypeScript errors before submitting.

### What not to do

- Don't commit code that has TypeScript errors (`npm run build` must pass)
- Don't let the agent add files the issue didn't require
- Don't use the agent to write the PR description

---

## Running Tests

```bash
make test                   # all apps via Turborepo
npm test                    # all apps via Turborepo
cd apps/api && npm test     # API only
cd apps/web && npm test     # frontend only
```

The CI pipeline automatically checks:
- Build success for both API and Web apps (`npm run build`)
- All unit tests pass across all workspace packages (`npm test`)
- ESLint checks pass with no warnings or errors (`npm run lint`)
- Prettier formatting is correct (`npm run format`)

---

## Code Style

- **TypeScript**: strict mode is on — no `any`, no `@ts-ignore` without a comment explaining why
- **NestJS services**: keep HTTP concerns (request/response) in the controller; all logic in the service
- **Frontend**: App Router patterns; `'use client'` only when necessary; Tailwind for all styles
- **Comments**: only if the *why* is genuinely non-obvious
- **No extra files**: don't add docs, notes, or helper scripts the issue didn't require

```bash
npm run lint      # ESLint across all apps
npm run format    # Prettier
```

---

## Opening a PR

**Title**: `feat: <short description> (closes #<number>)`

**Body should include**:
- What you built
- Any decisions made that weren't obvious from the issue
- How a reviewer can manually test it (which tool page to open, what to paste or click)

Always include `Closes #<issue-number>`.

**Checklist before submitting**:
- [ ] All acceptance criteria in the issue are satisfied
- [ ] `npm run build` completes without TypeScript errors
- [ ] `npm test` passes
- [ ] `npm run lint` passes (no new warnings)
- [ ] New NestJS module is registered in `app.module.ts`
- [ ] No files added beyond what the issue required

---

## Questions

Comment on the issue thread. Don't open a new issue to ask about an existing one.
