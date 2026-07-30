import { createClient } from 'npm:@supabase/supabase-js@2'

type SubmissionRow = {
  id: string
  project_id: number
  task_id: string
  submitted_by: string
  version: number
  file_name: string | null
  created_at: string
}

type ProfileRow = {
  id: string
  first_name: string | null
  last_name: string | null
  role: string | null
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  let adminClient: ReturnType<typeof createClient> | null = null
  let submissionId = ''

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY')
    if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase server configuration is missing')

    const authorization = request.headers.get('Authorization') || ''
    const accessToken = authorization.replace(/^Bearer\s+/i, '')
    if (!accessToken) return json({ ok: false, error: 'กรุณาเข้าสู่ระบบ' }, 401)

    adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: authData, error: authError } = await adminClient.auth.getUser(accessToken)
    if (authError || !authData.user) return json({ ok: false, error: 'เซสชันไม่ถูกต้องหรือหมดอายุ' }, 401)

    const body = await request.json()
    submissionId = String(body?.submission_id || '')
    if (!isUuid(submissionId)) return json({ ok: false, error: 'รหัสการส่งงานไม่ถูกต้อง' }, 400)

    const { data: submission, error: submissionError } = await adminClient
      .from('project_submissions')
      .select('id,project_id,task_id,submitted_by,version,file_name,created_at')
      .eq('id', submissionId)
      .maybeSingle()
    if (submissionError) throw submissionError
    if (!submission) return json({ ok: false, error: 'ไม่พบข้อมูลการส่งงาน' }, 404)

    const typedSubmission = submission as SubmissionRow
    if (typedSubmission.submitted_by !== authData.user.id) {
      return json({ ok: false, error: 'ไม่มีสิทธิ์ส่งการแจ้งเตือนสำหรับงานนี้' }, 403)
    }

    const [projectResult, taskResult, submitterResult, teachersResult] = await Promise.all([
      adminClient.from('student_projects').select('id,title,advisor').eq('id', typedSubmission.project_id).maybeSingle(),
      adminClient.from('project_tasks').select('id,title').eq('id', typedSubmission.task_id).maybeSingle(),
      adminClient.from('profiles').select('id,first_name,last_name,role').eq('id', typedSubmission.submitted_by).maybeSingle(),
      adminClient.from('profiles').select('id,first_name,last_name,role').eq('role', 'teacher'),
    ])

    if (projectResult.error) throw projectResult.error
    if (taskResult.error) throw taskResult.error
    if (submitterResult.error) throw submitterResult.error
    if (teachersResult.error) throw teachersResult.error
    if (!projectResult.data || !taskResult.data) throw new Error('Project or task was not found')

    const advisorName = normalizeName(projectResult.data.advisor)
    const matchingTeachers = ((teachersResult.data || []) as ProfileRow[])
      .filter((teacher) => normalizeName(`${teacher.first_name || ''} ${teacher.last_name || ''}`) === advisorName)

    if (!advisorName || matchingTeachers.length !== 1) {
      await recordFailure(adminClient, typedSubmission.id, '', '', matchingTeachers.length > 1
        ? 'พบชื่อครูที่ปรึกษาซ้ำกัน ไม่สามารถเลือกผู้รับอีเมลได้'
        : 'ไม่พบบัญชีครูที่ปรึกษาของโครงงาน')
      return json({ ok: false, error: 'ไม่พบอีเมลครูที่ปรึกษาที่ตรงกับโครงงาน' }, 422)
    }

    const advisor = matchingTeachers[0]
    const { data: advisorAuth, error: advisorAuthError } = await adminClient.auth.admin.getUserById(advisor.id)
    if (advisorAuthError) throw advisorAuthError
    const teacherEmail = String(advisorAuth.user?.email || '').trim().toLowerCase()
    if (!isEmail(teacherEmail)) {
      await recordFailure(adminClient, typedSubmission.id, advisor.id, '', 'บัญชีครูที่ปรึกษาไม่มีอีเมลที่ถูกต้อง')
      return json({ ok: false, error: 'บัญชีครูที่ปรึกษาไม่มีอีเมลที่ถูกต้อง' }, 422)
    }

    const { data: claimed, error: claimError } = await adminClient.rpc('claim_submission_email_notification', {
      p_submission_id: typedSubmission.id,
      p_recipient_user_id: advisor.id,
      p_recipient_email: teacherEmail,
    })
    if (claimError) throw claimError
    if (!claimed) return json({ ok: true, status: 'already_processing_or_sent' })

    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') || 'TrackPro <onboarding@resend.dev>'
    if (!resendApiKey) throw new Error('ยังไม่ได้ตั้งค่า RESEND_API_KEY บน Supabase')

    const submitter = submitterResult.data as ProfileRow | null
    const studentName = normalizeName(`${submitter?.first_name || ''} ${submitter?.last_name || ''}`) || 'นักเรียน'
    const projectTitle = String(projectResult.data.title || 'โครงงาน')
    const taskTitle = String(taskResult.data.title || 'หัวข้องาน')
    const appUrl = String(Deno.env.get('TRACKPRO_APP_URL') || '').replace(/\/+$/, '')
    const projectUrl = appUrl ? `${appUrl}/projectDetail.html?id=${encodeURIComponent(String(typedSubmission.project_id))}` : ''

    const providerResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `trackpro-submission-${typedSubmission.id}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [teacherEmail],
        subject: `[TrackPro] ${studentName} ส่งงาน: ${projectTitle}`,
        html: buildEmailHtml({
          advisorName,
          studentName,
          projectTitle,
          taskTitle,
          version: typedSubmission.version,
          fileName: typedSubmission.file_name || '',
          submittedAt: typedSubmission.created_at,
          projectUrl,
        }),
      }),
    })

    const providerData = await providerResponse.json().catch(() => ({}))
    if (!providerResponse.ok) {
      throw new Error(String(providerData?.message || `Resend returned HTTP ${providerResponse.status}`))
    }

    const { error: sentError } = await adminClient
      .from('submission_email_notifications')
      .update({
        status: 'sent',
        provider_message_id: String(providerData?.id || ''),
        error_message: '',
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('submission_id', typedSubmission.id)
    if (sentError) throw sentError

    return json({ ok: true, status: 'sent' })
  } catch (error) {
    console.error(error)
    if (adminClient && isUuid(submissionId)) {
      await adminClient
        .from('submission_email_notifications')
        .update({
          status: 'failed',
          error_message: errorMessage(error).slice(0, 2000),
          updated_at: new Date().toISOString(),
        })
        .eq('submission_id', submissionId)
    }
    return json({ ok: false, error: errorMessage(error) }, 500)
  }
})

async function recordFailure(
  client: ReturnType<typeof createClient>,
  submissionId: string,
  recipientUserId: string,
  recipientEmail: string,
  message: string,
) {
  const { data: existing } = await client
    .from('submission_email_notifications')
    .select('attempt_count')
    .eq('submission_id', submissionId)
    .maybeSingle()

  await client.from('submission_email_notifications').upsert({
    submission_id: submissionId,
    recipient_user_id: recipientUserId || null,
    recipient_email: recipientEmail,
    status: 'failed',
    attempt_count: Number(existing?.attempt_count || 0) + 1,
    error_message: message.slice(0, 2000),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'submission_id' })
}

function buildEmailHtml(details: {
  advisorName: string
  studentName: string
  projectTitle: string
  taskTitle: string
  version: number
  fileName: string
  submittedAt: string
  projectUrl: string
}) {
  const submittedAt = new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(details.submittedAt))
  const fileRow = details.fileName
    ? `<tr><td style="padding:7px 0;color:#7b6e62">ไฟล์ที่แนบ</td><td style="padding:7px 0;font-weight:700">${escapeHtml(details.fileName)}</td></tr>`
    : ''
  const action = details.projectUrl
    ? `<p style="margin:24px 0 4px"><a href="${escapeHtml(details.projectUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#769a7b;color:#fff;text-decoration:none;font-weight:700">เปิดหน้าตรวจงาน</a></p>`
    : '<p style="margin:20px 0 4px;color:#7b6e62">กรุณาเข้าสู่ระบบ TrackPro เพื่อเปิดตรวจงาน</p>'

  return `<!doctype html><html lang="th"><body style="margin:0;background:#f4efe7;font-family:Arial,'Noto Sans Thai',sans-serif;color:#483d34"><div style="max-width:620px;margin:0 auto;padding:28px 16px"><div style="padding:28px;border:1px solid #e1d6c8;border-radius:18px;background:#fff"><div style="margin-bottom:20px;color:#66856b;font-size:13px;font-weight:800;letter-spacing:.08em">TRACKPRO</div><h1 style="margin:0 0 10px;font-size:24px">มีงานใหม่รอตรวจ</h1><p style="margin:0 0 20px;color:#74685d">เรียน ${escapeHtml(details.advisorName)} นักเรียนได้ส่งงานเข้ามาในโครงงานที่คุณดูแล</p><table style="width:100%;border-collapse:collapse;font-size:14px"><tr><td style="padding:7px 0;color:#7b6e62">นักเรียน</td><td style="padding:7px 0;font-weight:700">${escapeHtml(details.studentName)}</td></tr><tr><td style="padding:7px 0;color:#7b6e62">โครงงาน</td><td style="padding:7px 0;font-weight:700">${escapeHtml(details.projectTitle)}</td></tr><tr><td style="padding:7px 0;color:#7b6e62">หัวข้องาน</td><td style="padding:7px 0;font-weight:700">${escapeHtml(details.taskTitle)}</td></tr><tr><td style="padding:7px 0;color:#7b6e62">รอบการส่ง</td><td style="padding:7px 0;font-weight:700">รอบที่ ${details.version}</td></tr>${fileRow}<tr><td style="padding:7px 0;color:#7b6e62">เวลาที่ส่ง</td><td style="padding:7px 0;font-weight:700">${escapeHtml(submittedAt)} น.</td></tr></table>${action}</div></div></body></html>`
}

function normalizeName(value: unknown) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isEmail(value: string) {
  return /^\S+@\S+\.\S+$/.test(value) && value.length <= 320
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] || character)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'ส่งอีเมลไม่สำเร็จ')
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  })
}
