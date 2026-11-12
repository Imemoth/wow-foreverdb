# Database and Vercel deployment scope

Database SQL, migrations and backend-only tests have their own review and CI requirements. They do not by themselves require a new Next.js/Vercel website deployment.

The canonical source-controlled deployment filter and retention policy is [docs/web/vercel-deployment-policy.md](../docs/web/vercel-deployment-policy.md).

This file is a backend-only Git change used to verify the Vercel Ignored Build Step in Draft PR #198. It does **not** approve or execute a database migration, production rollout, or deployment cleanup.
