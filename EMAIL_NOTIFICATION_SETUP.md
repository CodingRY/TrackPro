# TrackPro email notifications

The database migration and `notify-teacher-submission` Edge Function are deployed.
To enable real email delivery, configure these Supabase Edge Function secrets:

- `RESEND_API_KEY` — required Resend API key.
- `RESEND_FROM_EMAIL` — recommended, for example `TrackPro <notify@school.example>`.
- `TRACKPRO_APP_URL` — optional public site URL used by the “open review page” button.

For production delivery to teacher addresses, the domain in `RESEND_FROM_EMAIL` must be verified in Resend.
Do not put any of these secrets in HTML or browser JavaScript.

After the secrets are set, no function redeployment is required. Each successful call to
`submit_project_task` is followed by an authenticated invocation of the Edge Function. The
function verifies the submitting student, resolves the assigned teacher’s Auth email, and uses
the submission UUID as both the database deduplication key and the Resend idempotency key.
