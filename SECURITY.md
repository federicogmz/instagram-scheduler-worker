# Security policy

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab) rather than a public issue.
Include steps to reproduce and the affected version. You can expect an answer within a few days.

Scope notes: the Worker holds a Meta access token and an admin secret. Anything that lets an unauthenticated caller read them,
publish, or read unpublished captions is in scope. `/media/*` and `/status` are intentionally public.
