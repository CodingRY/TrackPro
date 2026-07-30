const SUPABASE_URL = 'https://klszrjhdpvsiktddzpga.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtsc3pyamhkcHZzaWt0ZGR6cGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDMzODMsImV4cCI6MjA4NzA3OTM4M30.zcK4gseuAMxweSWEGWYSuUcPui0EJgOcE66XsKw6wUM'
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const projectId = new URLSearchParams(location.search).get('id')
let workspace = null
let loadingWorkspace = false
let mutationInProgress = false
let toastTimer = null
let pollTimer = null

document.getElementById('refreshButton').addEventListener('click', () => loadWorkspace(false, true))
document.getElementById('approveProjectButton').addEventListener('click', approveProject)
document.getElementById('showTaskForm').addEventListener('click', () => openTaskForm())
document.getElementById('cancelTaskEdit').addEventListener('click', closeTaskForm)
document.getElementById('taskForm').addEventListener('submit', saveTask)
document.getElementById('messageForm').addEventListener('submit', sendMessage)
document.getElementById('messageInput').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (!event.currentTarget.value.trim()) return
  document.getElementById('messageForm').requestSubmit()
})
document.getElementById('accountMenuButton').addEventListener('click', toggleAccountMenu)
document.getElementById('accountLogout').addEventListener('click', logoutAccount)
document.getElementById('showDeadlineForm').addEventListener('click', openDeadlineForm)
document.getElementById('cancelDeadlineEdit').addEventListener('click', closeDeadlineForm)
document.getElementById('hasCompetitionDeadline').addEventListener('change', toggleCompetitionDeadlineFields)
document.getElementById('proposalDueDate').addEventListener('change', syncCompetitionMinimumDate)
document.getElementById('deadlineForm').addEventListener('submit', saveProjectDeadlines)
document.addEventListener('click', event => {
  if (!event.target.closest('#accountMenu')) closeAccountMenu()
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeAccountMenu(true)
})

init()

function toggleAccountMenu(event) {
  event.stopPropagation()
  const button = document.getElementById('accountMenuButton')
  const dropdown = document.getElementById('accountDropdown')
  const willOpen = dropdown.hidden
  dropdown.hidden = !willOpen
  button.setAttribute('aria-expanded', String(willOpen))
}

function closeAccountMenu(returnFocus = false) {
  const button = document.getElementById('accountMenuButton')
  const dropdown = document.getElementById('accountDropdown')
  if (dropdown.hidden) return
  dropdown.hidden = true
  button.setAttribute('aria-expanded', 'false')
  if (returnFocus) button.focus()
}

async function logoutAccount() {
  const button = document.getElementById('accountLogout')
  button.disabled = true
  const { error } = await sb.auth.signOut()
  if (error) {
    button.disabled = false
    showToast('ออกจากระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', true)
    return
  }
  location.href = 'index.html'
}

async function init() {
  if (!projectId || !/^\d+$/.test(projectId)) return showPageError('ไม่พบรหัสโครงงานที่ถูกต้อง')
  const { data: { user }, error } = await sb.auth.getUser()
  if (error || !user) {
    location.href = 'index.html'
    return
  }

  await loadWorkspace(true)
  pollTimer = window.setInterval(() => {
    if (!document.hidden && !isEditing()) loadWorkspace(false)
  }, 15000)
}

async function loadWorkspace(isInitial = false, showSuccess = false) {
  if (loadingWorkspace) return
  loadingWorkspace = true
  const previousMessageCount = workspace?.messages?.length || 0

  try {
    const { data, error } = await sb.rpc('get_project_workspace', { p_project_id: Number(projectId) })
    if (error) throw error
    workspace = Array.isArray(data) ? data[0] : data
    if (!workspace?.project) throw new Error('ไม่พบข้อมูลพื้นที่โครงงาน')

    await Promise.all([attachProjectDeadlines(), attachTeacherReviewFiles()])
    renderWorkspace(previousMessageCount)
    if (workspace.viewer.is_advisor) loadProjectLearningProgress()
    document.getElementById('pageLoading').hidden = true
    document.getElementById('pageError').hidden = true
    document.getElementById('workspaceContent').hidden = false
    if (showSuccess) showToast('อัปเดตข้อมูลล่าสุดแล้ว')
  } catch (error) {
    console.error(error)
    if (isInitial) showPageError(readableError(error))
  } finally {
    loadingWorkspace = false
  }
}

async function attachProjectDeadlines() {
  const { data, error } = await sb
    .from('student_projects')
    .select('proposal_due_date,competition_name,competition_due_date')
    .eq('id', Number(projectId))
    .single()
  if (error) throw error
  Object.assign(workspace.project, data || {})
}

async function attachTeacherReviewFiles() {
  const submissionIds = (workspace.tasks || [])
    .flatMap(task => task.submissions || [])
    .map(submission => submission.id)
  if (!submissionIds.length) return

  const { data, error } = await sb
    .from('project_submissions')
    .select('id,teacher_file_path,teacher_file_name,teacher_mime_type,teacher_file_size')
    .in('id', submissionIds)
  if (error) throw error

  const filesBySubmission = new Map((data || []).map(item => [item.id, item]))
  workspace.tasks.forEach(task => {
    ;(task.submissions || []).forEach(submission => {
      Object.assign(submission, filesBySubmission.get(submission.id) || {})
    })
  })
}

function renderWorkspace(previousMessageCount) {
  const { project, viewer, members, tasks, messages } = workspace
  const progress = clampProgress(project.progress)
  const passedCount = tasks.filter(task => task.submissions?.some(submission => submission.status === 'passed')).length
  const fullName = viewer.name || 'ผู้ใช้งาน'

  document.title = `${project.title || 'พื้นที่โครงงาน'} | TrackPro`
  document.getElementById('accountName').textContent = fullName
  document.getElementById('accountAvatar').textContent = fullName.charAt(0).toUpperCase()
  document.getElementById('accountRole').textContent = viewer.is_advisor ? 'ครูที่ปรึกษา' : viewer.is_student ? 'สมาชิกโครงงาน' : 'ผู้ดูแลระบบ'
  document.getElementById('editProfileLink').hidden = viewer.role === 'admin'
  document.getElementById('projectTitle').textContent = project.title || 'ไม่มีชื่อโครงงาน'
  document.getElementById('projectDescription').textContent = project.description || 'ยังไม่มีรายละเอียดโครงงาน'
  document.getElementById('projectCategory').textContent = project.category || 'ไม่ระบุหมวดหมู่'
  const advisorName = project.advisor || 'ยังไม่ระบุครูที่ปรึกษา'
  document.getElementById('projectAdvisor').textContent = advisorName
  document.getElementById('chatParticipants').textContent = project.advisor
    ? `ครูที่ปรึกษา ${project.advisor} และสมาชิกทุกคน`
    : 'ครูที่ปรึกษาและสมาชิกทุกคน'
  document.getElementById('projectMembers').textContent = members.map(member => member.name).filter(Boolean).join(', ') || project.student_name || '-'
  document.getElementById('projectProgress').textContent = `${progress}%`
  document.getElementById('projectProgressBar').style.width = `${progress}%`
  document.getElementById('projectTaskSummary').textContent = tasks.length ? `ผ่านแล้ว ${passedCount} จาก ${tasks.length} หัวข้อ` : 'ยังไม่มีหัวข้องาน'

  const status = normalizeProjectStatus(project.status)
  const statusElement = document.getElementById('projectStatus')
  statusElement.textContent = projectStatusLabel(status)
  statusElement.className = `status-badge ${status}`
  const approveButton = document.getElementById('approveProjectButton')
  approveButton.hidden = !viewer.is_advisor || !['pending', 'rejected'].includes(status)
  approveButton.textContent = status === 'rejected' ? '✓ เปลี่ยนเป็นอนุมัติ' : '✓ อนุมัติโครงงาน'

  const home = viewer.role === 'admin' ? 'admin.html' : 'dashboard.html'
  document.getElementById('brandHome').href = home
  document.getElementById('backLink').href = home

  document.getElementById('showTaskForm').hidden = !viewer.is_advisor
  document.getElementById('showDeadlineForm').hidden = !viewer.is_advisor
  renderProjectDeadlines()
  const notice = document.getElementById('viewerNotice')
  if (viewer.role === 'admin') {
    notice.textContent = '🛡️ ผู้ดูแลระบบเปิดดูพื้นที่โครงงานได้เท่านั้น การเพิ่มหัวข้องานและตรวจงานเป็นสิทธิ์ของครูที่ปรึกษา'
    notice.hidden = false
    document.getElementById('messageForm').hidden = true
  } else {
    notice.hidden = true
    document.getElementById('messageForm').hidden = false
  }

  renderTasks()
  renderMessages(previousMessageCount)
}

async function approveProject() {
  if (!workspace?.viewer?.is_advisor) {
    showToast('เฉพาะครูที่ปรึกษาของโครงงานเท่านั้นที่อนุมัติโครงงานได้', true)
    return
  }

  const currentStatus = normalizeProjectStatus(workspace.project.status)
  if (currentStatus === 'approved') return
  const confirmation = currentStatus === 'rejected'
    ? 'ยืนยันเปลี่ยนโครงงานที่ไม่ผ่านให้เป็นอนุมัติแล้ว?'
    : 'ยืนยันอนุมัติโครงงานนี้?'
  if (!confirm(confirmation)) return

  const button = document.getElementById('approveProjectButton')
  button.disabled = true
  button.textContent = 'กำลังอนุมัติ...'
  mutationInProgress = true

  try {
    const { data, error } = await sb
      .from('student_projects')
      .update({ status: 'approved' })
      .eq('id', Number(projectId))
      .eq('advisor', workspace.project.advisor)
      .select('id,status')

    if (error) throw error
    if (data?.length !== 1) throw new Error('Only the assigned advisor can review this project')
    await loadWorkspace(false)
    showToast('อนุมัติโครงงานเรียบร้อยแล้ว')
  } catch (error) {
    showToast(readableError(error), true)
  } finally {
    mutationInProgress = false
    button.disabled = false
    if (!button.hidden) button.textContent = '✓ อนุมัติโครงงาน'
  }
}

function renderProjectDeadlines() {
  renderDeadlineCard('proposalDeadlineCard', 'proposalDeadlineText', 'proposalDeadlineStatus', workspace.project.proposal_due_date)

  const competitionCard = document.getElementById('competitionDeadlineCard')
  const hasCompetition = Boolean(workspace.project.competition_due_date)
  competitionCard.hidden = !hasCompetition
  if (hasCompetition) {
    document.getElementById('competitionDeadlineLabel').textContent = workspace.project.competition_name || 'กำหนดส่งแข่งขัน'
    renderDeadlineCard('competitionDeadlineCard', 'competitionDeadlineText', 'competitionDeadlineStatus', workspace.project.competition_due_date)
  }
}

function renderDeadlineCard(cardId, textId, statusId, dateValue) {
  const card = document.getElementById(cardId)
  card.classList.remove('overdue', 'today')
  if (!dateValue) {
    document.getElementById(textId).textContent = 'ยังไม่กำหนด'
    document.getElementById(statusId).textContent = 'รอครูที่ปรึกษากำหนดวัน'
    return
  }

  const state = getDeadlineState(dateValue)
  document.getElementById(textId).textContent = formatDeadlineDate(dateValue)
  document.getElementById(statusId).textContent = state.label
  if (state.kind !== 'upcoming') card.classList.add(state.kind)
}

function openDeadlineForm() {
  const project = workspace.project
  document.getElementById('proposalDueDate').value = project.proposal_due_date || ''
  const hasCompetition = Boolean(project.competition_due_date)
  document.getElementById('hasCompetitionDeadline').checked = hasCompetition
  document.getElementById('competitionName').value = project.competition_name || ''
  document.getElementById('competitionDueDate').value = project.competition_due_date || ''
  toggleCompetitionDeadlineFields()
  syncCompetitionMinimumDate()
  document.getElementById('deadlineForm').hidden = false
  document.getElementById('deadlineForm').scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function closeDeadlineForm() {
  document.getElementById('deadlineForm').hidden = true
}

function toggleCompetitionDeadlineFields() {
  const enabled = document.getElementById('hasCompetitionDeadline').checked
  document.getElementById('competitionDeadlineFields').hidden = !enabled
  document.getElementById('competitionName').required = enabled
  document.getElementById('competitionDueDate').required = enabled
}

function syncCompetitionMinimumDate() {
  const proposalDate = document.getElementById('proposalDueDate').value
  const competitionInput = document.getElementById('competitionDueDate')
  competitionInput.min = proposalDate
  if (proposalDate && competitionInput.value && competitionInput.value < proposalDate) competitionInput.value = proposalDate
}

async function saveProjectDeadlines(event) {
  event.preventDefault()
  const button = document.getElementById('saveDeadlineButton')
  const proposalDate = document.getElementById('proposalDueDate').value
  const hasCompetition = document.getElementById('hasCompetitionDeadline').checked
  const competitionName = hasCompetition ? document.getElementById('competitionName').value.trim() : ''
  const competitionDate = hasCompetition ? document.getElementById('competitionDueDate').value : null
  if (!proposalDate) return showToast('กรุณากำหนดวันส่งข้อเสนอโครงงาน', true)
  if (hasCompetition && (!competitionName || !competitionDate)) return showToast('กรุณาระบุชื่อการแข่งขันและกำหนดส่ง', true)
  if (competitionDate && competitionDate < proposalDate) return showToast('กำหนดส่งแข่งขันต้องไม่อยู่ก่อนวันส่งข้อเสนอ', true)

  mutationInProgress = true
  setButtonBusy(button, true, 'กำลังบันทึก...')
  const { error } = await sb.rpc('update_project_deadlines', {
    p_project_id: Number(projectId),
    p_proposal_due_date: proposalDate,
    p_competition_name: competitionName,
    p_competition_due_date: competitionDate
  })
  mutationInProgress = false
  setButtonBusy(button, false, 'บันทึกกำหนดการ')
  if (error) return showToast(readableError(error), true)
  closeDeadlineForm()
  showToast('บันทึกกำหนดส่งโครงงานแล้ว')
  await loadWorkspace(false)
}

async function loadProjectLearningProgress() {
  const panel = document.getElementById('studentLearningPanel')
  const list = document.getElementById('studentLearningList')
  const students = workspace.members || []
  panel.hidden = false

  if (!students.length) {
    list.innerHTML = '<div class="learning-progress-error">ยังไม่มีนักเรียนในโครงงานนี้</div>'
    return
  }

  try {
    const [lessonResult, progressResult] = await Promise.all([
      sb.from('learning_lessons').select('id, duration_seconds').eq('is_published', true),
      sb.from('learning_progress')
        .select('student_id, lesson_id, watched_seconds, completed')
        .in('student_id', students.map(student => student.id))
    ])
    if (lessonResult.error) throw lessonResult.error
    if (progressResult.error) throw progressResult.error

    const lessons = lessonResult.data || []
    const progressRows = progressResult.data || []
    const totalRequired = lessons.reduce((sum, lesson) => sum + (Number(lesson.duration_seconds) || 0), 0)
    const summaries = students.map(student => {
      let watchedSeconds = 0
      let completedCount = 0
      lessons.forEach(lesson => {
        const row = progressRows.find(item => item.student_id === student.id && item.lesson_id === lesson.id)
        watchedSeconds += Math.min(Number(row?.watched_seconds) || 0, Number(lesson.duration_seconds) || 0)
        if (row?.completed) completedCount += 1
      })
      return {
        ...student,
        watchedSeconds,
        completedCount,
        percent: totalRequired ? Math.min(100, Math.round(watchedSeconds * 100 / totalRequired)) : 0
      }
    })

    const average = summaries.length
      ? Math.round(summaries.reduce((sum, student) => sum + student.percent, 0) / summaries.length)
      : 0
    document.getElementById('projectLearningAverage').textContent = `เฉลี่ย ${average}%`
    list.innerHTML = summaries.map(student => `
      <article class="student-learning-card">
        <span class="student-learning-avatar">${escapeHtml((student.name || 'น').charAt(0).toUpperCase())}</span>
        <div class="student-learning-copy">
          <strong>${escapeHtml(student.name || 'ไม่ระบุชื่อ')}</strong>
          <small>${student.team_role === 'leader' ? 'หัวหน้ากลุ่ม' : 'สมาชิกกลุ่ม'} • สำเร็จ ${student.completedCount}/${lessons.length} บท • ${formatLearningDuration(student.watchedSeconds)}</small>
          <div class="student-learning-track"><span style="width:${student.percent}%"></span></div>
        </div>
        <strong class="student-learning-percent">${student.percent}%</strong>
      </article>
    `).join('')
  } catch (error) {
    console.error(error)
    list.innerHTML = '<div class="learning-progress-error">โหลดความคืบหน้าการเรียนไม่สำเร็จ กรุณากดอัปเดตข้อมูลอีกครั้ง</div>'
  }
}

function renderTasks() {
  const tasks = [...(workspace.tasks || [])].sort((a, b) => a.sort_order - b.sort_order)
  const empty = document.getElementById('tasksEmpty')
  empty.hidden = tasks.length > 0
  document.getElementById('tasksEmptyText').textContent = workspace.viewer.is_advisor
    ? 'เพิ่มหัวข้องานแรกเพื่อเริ่มขั้นตอนการส่งตรวจ'
    : 'รอครูที่ปรึกษาเพิ่มหัวข้องานแรก'

  let previousTasksPassed = true
  document.getElementById('tasksList').innerHTML = tasks.map((task, index) => {
    const submissions = [...(task.submissions || [])].sort((a, b) => b.version - a.version)
    const latest = submissions[0]
    const passed = submissions.some(submission => submission.status === 'passed')
    const state = getTaskState(previousTasksPassed, passed, latest)
    const card = renderTaskCard(task, index, submissions, latest, state)
    previousTasksPassed = previousTasksPassed && passed
    return card
  }).join('')

  bindTaskEvents()
}

function getTaskState(previousTasksPassed, passed, latest) {
  if (passed) return 'passed'
  if (!previousTasksPassed) return 'locked'
  if (latest?.status === 'submitted') return 'review'
  if (latest?.status === 'revision_requested') return 'revision'
  return 'current'
}

function renderTaskCard(task, index, submissions, latest, state) {
  const stateLabel = ({
    passed: '✓ ผ่านแล้ว', locked: '🔒 ยังไม่เปิด', review: 'รอครูตรวจ', revision: 'ต้องแก้ไข', current: 'กำลังดำเนินการ'
  })[state]
  const studentAction = workspace.viewer.is_student ? renderStudentAction(task, state, latest) : ''
  const teacherReview = workspace.viewer.is_advisor && state === 'review' ? renderReviewForm(latest) : ''
  const readOnlyState = !workspace.viewer.is_student && !workspace.viewer.is_advisor
    ? '<div class="locked-note">เปิดดูข้อมูลในโหมดอ่านอย่างเดียว</div>' : ''
  const teacherActions = workspace.viewer.is_advisor
    ? `<div class="teacher-task-actions"><button type="button" data-edit-task="${task.id}">✏️ แก้ไขหัวข้อ</button><button class="danger-button" type="button" data-delete-task="${task.id}">🗑 ลบหัวข้อ</button></div>` : ''

  return `<article class="task-card ${state}">
    <div class="task-head">
      <span class="task-number">${state === 'passed' ? '✓' : index + 1}</span>
      <div class="task-title"><h3>${escapeHtml(task.title)}</h3><p>${submissions.length ? `ส่งแล้ว ${submissions.length} รอบ` : 'ยังไม่มีการส่งงาน'}</p></div>
      <span class="task-state">${stateLabel}</span>
    </div>
    <div class="task-body">
      <p class="task-instructions">${escapeHtml(task.instructions || 'ครูยังไม่ได้ระบุคำชี้แจงเพิ่มเติม')}</p>
      ${teacherActions}
      ${studentAction}
      ${teacherReview}
      ${readOnlyState}
      ${renderSubmissionHistory(submissions)}
    </div>
  </article>`
}

function renderStudentAction(task, state, latest) {
  if (state === 'locked') return '<div class="locked-note">🔒 ต้องผ่านหัวข้อก่อนหน้าจึงจะส่งงานหัวข้อนี้ได้</div>'
  if (state === 'passed') return '<div class="passed-note">✅ ครูตรวจผ่านแล้ว หัวข้อถัดไปถูกปลดล็อกเรียบร้อย</div>'
  if (state === 'review') return '<div class="waiting-note">⏳ ส่งงานแล้วและกำลังรอครูที่ปรึกษาตรวจ</div>'

  const revision = state === 'revision' && latest
    ? `<div class="revision-note"><strong>ครูขอให้แก้ไข:</strong><br>${escapeHtml(latest.teacher_feedback || '')}</div>` : ''
  return `${revision}
    <form class="submission-form" data-submit-task="${task.id}">
      <div><label>ข้อความถึงครู</label><textarea data-submission-message rows="3" maxlength="2000" placeholder="อธิบายงานที่ส่งหรือสิ่งที่แก้ไขเพิ่มเติม"></textarea></div>
      <div class="file-field"><label>แนบไฟล์งาน (ถ้ามี)</label><input data-submission-file type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.zip,.txt"><div class="file-hint">ขนาดไม่เกิน 20 MB • สามารถส่งข้อความโดยไม่แนบไฟล์ได้</div></div>
      <div class="form-actions"><button class="primary-button" type="submit">${state === 'revision' ? 'ส่งงานที่แก้ไขแล้ว' : 'ส่งงานให้ครูตรวจ'}</button></div>
    </form>`
}

function renderReviewForm(submission) {
  return `<form class="review-form" data-review-submission="${submission.id}">
    <label>ความคิดเห็นและข้อเสนอแนะ</label>
    <textarea data-review-feedback rows="3" maxlength="2000" placeholder="ระบุสิ่งที่ต้องแก้ไข หรือเขียนคำแนะนำเพิ่มเติม"></textarea>
    <div class="file-field"><label>แนบไฟล์ที่ครูแก้ไขแล้ว <span class="optional-label">(ไม่บังคับ)</span></label><input data-review-file type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.zip,.txt"><div class="file-hint">นักเรียนจะดาวน์โหลดไฟล์นี้ได้จากประวัติการส่งงาน • ขนาดไม่เกิน 20 MB</div></div>
    <div class="review-actions">
      <button class="review-button revise" type="button" data-review-decision="revision_requested">↩ ขอให้แก้ไข</button>
      <button class="review-button pass" type="button" data-review-decision="passed">✓ ผ่านหัวข้อนี้</button>
    </div>
  </form>`
}

function renderSubmissionHistory(submissions) {
  if (!submissions.length) return ''
  return `<details class="submission-history" ${submissions[0]?.status === 'submitted' || submissions[0]?.status === 'revision_requested' ? 'open' : ''}>
    <summary>ประวัติการส่งงาน ${submissions.length} รอบ</summary>
    ${submissions.map(submission => {
      const statusText = ({ submitted: 'รอตรวจ', revision_requested: 'ให้แก้ไข', passed: 'ผ่าน' })[submission.status] || submission.status
      const feedback = submission.teacher_feedback
        ? `<div class="feedback-box ${submission.status === 'passed' ? 'passed' : ''}"><strong>ความคิดเห็นครู:</strong><br>${escapeHtml(submission.teacher_feedback)}</div>` : ''
      const file = submission.file_path
        ? `<button class="file-button" type="button" data-file-path="${escapeHtml(submission.file_path)}" data-file-name="${escapeHtml(submission.file_name || 'งานที่ส่ง')}">📥 ดาวน์โหลด ${escapeHtml(submission.file_name || 'งานที่ส่ง')}</button>` : ''
      const teacherFile = submission.teacher_file_path
        ? `<div class="teacher-file-box"><span><strong>ไฟล์ที่ครูแก้ไขและส่งกลับ</strong><small>${escapeHtml(submission.teacher_file_name || 'ไฟล์จากครูที่ปรึกษา')}</small></span><button class="file-button teacher-file-button" type="button" data-file-path="${escapeHtml(submission.teacher_file_path)}" data-file-name="${escapeHtml(submission.teacher_file_name || 'ไฟล์จากครูที่ปรึกษา')}">📥 ดาวน์โหลด</button></div>` : ''
      return `<div class="submission-item">
        <div class="submission-meta"><span>รอบที่ ${submission.version} • ${escapeHtml(submission.submitted_by || 'นักเรียน')}</span><strong>${statusText}</strong></div>
        ${submission.message ? `<div class="submission-message">${escapeHtml(submission.message)}</div>` : ''}
        ${file}${feedback}${teacherFile}
        <div class="submission-meta"><span>${formatDateTime(submission.created_at)}</span>${submission.reviewed_at ? `<span>ตรวจเมื่อ ${formatDateTime(submission.reviewed_at)}</span>` : ''}</div>
      </div>`
    }).join('')}
  </details>`
}

function bindTaskEvents() {
  document.querySelectorAll('[data-submit-task]').forEach(form => form.addEventListener('submit', submitTask))
  document.querySelectorAll('[data-review-decision]').forEach(button => button.addEventListener('click', reviewSubmission))
  document.querySelectorAll('[data-file-path]').forEach(button => button.addEventListener('click', () => openSubmissionFile(button.dataset.filePath, button.dataset.fileName, button)))
  document.querySelectorAll('[data-edit-task]').forEach(button => button.addEventListener('click', () => openTaskForm(button.dataset.editTask)))
  document.querySelectorAll('[data-delete-task]').forEach(button => button.addEventListener('click', () => deleteTask(button.dataset.deleteTask)))
}

function openTaskForm(taskId = '') {
  const form = document.getElementById('taskForm')
  const task = workspace.tasks.find(item => item.id === taskId)
  document.getElementById('editingTaskId').value = task?.id || ''
  document.getElementById('taskTitle').value = task?.title || ''
  document.getElementById('taskInstructions').value = task?.instructions || ''
  document.getElementById('saveTaskButton').textContent = task ? 'บันทึกการแก้ไข' : 'เพิ่มหัวข้องาน'
  form.hidden = false
  document.getElementById('taskTitle').focus()
  form.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function closeTaskForm() {
  document.getElementById('taskForm').reset()
  document.getElementById('editingTaskId').value = ''
  document.getElementById('taskForm').hidden = true
}

async function saveTask(event) {
  event.preventDefault()
  const button = document.getElementById('saveTaskButton')
  const taskId = document.getElementById('editingTaskId').value
  const title = document.getElementById('taskTitle').value.trim()
  const instructions = document.getElementById('taskInstructions').value.trim()
  if (!title) return showToast('กรุณาระบุชื่อหัวข้องาน', true)

  setButtonBusy(button, true, 'กำลังบันทึก...')
  const result = taskId
    ? await sb.rpc('update_project_task', { p_task_id: taskId, p_title: title, p_instructions: instructions })
    : await sb.rpc('add_project_task', { p_project_id: Number(projectId), p_title: title, p_instructions: instructions })
  setButtonBusy(button, false, taskId ? 'บันทึกการแก้ไข' : 'เพิ่มหัวข้องาน')

  if (result.error) return showToast(readableError(result.error), true)
  closeTaskForm()
  showToast(taskId ? 'แก้ไขหัวข้องานแล้ว' : 'เพิ่มหัวข้องานแล้ว')
  await loadWorkspace(false)
}

async function deleteTask(taskId) {
  const task = workspace.tasks.find(item => item.id === taskId)
  if (!task || !confirm(`ยืนยันลบหัวข้อ “${task.title}” และประวัติการส่งทั้งหมด?`)) return

  const filePaths = (task.submissions || []).flatMap(item => [item.file_path, item.teacher_file_path]).filter(Boolean)
  const { error } = await sb.rpc('delete_project_task', { p_task_id: taskId })
  if (error) return showToast(readableError(error), true)
  if (filePaths.length) await sb.storage.from('project-submissions').remove(filePaths)
  closeTaskForm()
  showToast('ลบหัวข้องานแล้ว')
  await loadWorkspace(false)
}

async function submitTask(event) {
  event.preventDefault()
  const form = event.currentTarget
  const button = form.querySelector('button[type="submit"]')
  const message = form.querySelector('[data-submission-message]').value.trim()
  const file = form.querySelector('[data-submission-file]').files[0]
  if (!message && !file) return showToast('กรุณาเขียนข้อความหรือแนบไฟล์งาน', true)
  if (file && file.size > 20 * 1024 * 1024) return showToast('ไฟล์ต้องมีขนาดไม่เกิน 20 MB', true)

  const originalButtonText = button.textContent
  mutationInProgress = true
  setButtonBusy(button, true, file ? 'กำลังอัปโหลดและส่งงาน...' : 'กำลังส่งงาน...')
  let filePath = null
  try {
    if (file) {
      const extension = getSafeExtension(file.name)
      const uniqueName = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
      filePath = `${projectId}/${workspace.viewer.id}/${uniqueName}${extension}`
      const uploadMimeType = getUploadMimeType(file)
      const { error: uploadError } = await sb.storage.from('project-submissions').upload(filePath, file, { contentType: uploadMimeType, upsert: false })
      if (uploadError) throw uploadError
    }

    const { data: createdSubmission, error } = await sb.rpc('submit_project_task', {
      p_task_id: form.dataset.submitTask,
      p_message: message,
      p_file_path: filePath,
      p_file_name: file?.name || null,
      p_mime_type: file ? getUploadMimeType(file) : null,
      p_file_size: file?.size || null
    })
    if (error) throw error
    form.reset()

    const submission = Array.isArray(createdSubmission) ? createdSubmission[0] : createdSubmission
    let notificationFailed = false
    if (submission?.id) {
      const { error: notificationError } = await sb.functions.invoke('notify-teacher-submission', {
        body: { submission_id: submission.id }
      })
      if (notificationError) {
        notificationFailed = true
        console.error('Teacher email notification failed', notificationError)
      }
    } else {
      notificationFailed = true
    }

    showToast(notificationFailed
      ? 'ส่งงานเรียบร้อยแล้ว แต่ยังส่งอีเมลแจ้งครูไม่สำเร็จ'
      : 'ส่งงานและอีเมลแจ้งครูที่ปรึกษาเรียบร้อยแล้ว', notificationFailed)
    await loadWorkspace(false)
  } catch (error) {
    if (filePath) await sb.storage.from('project-submissions').remove([filePath])
    showToast(readableError(error), true)
  } finally {
    mutationInProgress = false
    setButtonBusy(button, false, originalButtonText)
  }
}

async function reviewSubmission(event) {
  const button = event.currentTarget
  const form = button.closest('[data-review-submission]')
  const decision = button.dataset.reviewDecision
  const feedback = form.querySelector('[data-review-feedback]').value.trim()
  const file = form.querySelector('[data-review-file]').files[0]
  if (decision === 'revision_requested' && !feedback) return showToast('กรุณาระบุความคิดเห็นที่ต้องการให้นักเรียนแก้ไข', true)
  if (file && file.size > 20 * 1024 * 1024) return showToast('ไฟล์จากครูต้องมีขนาดไม่เกิน 20 MB', true)
  const prompt = decision === 'passed' ? 'ยืนยันให้ผ่านหัวข้อนี้และเปิดหัวข้อถัดไป?' : 'ส่งความคิดเห็นให้นักเรียนแก้ไขงานรอบใหม่?'
  if (!confirm(prompt)) return

  const originalButtonText = button.textContent
  let teacherFilePath = null
  mutationInProgress = true
  form.querySelectorAll('button').forEach(item => { item.disabled = true })
  button.textContent = file ? 'กำลังอัปโหลดและส่งผลตรวจ...' : 'กำลังส่งผลตรวจ...'
  try {
    if (file) {
      const extension = getSafeExtension(file.name)
      const uniqueName = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
      teacherFilePath = `${projectId}/${workspace.viewer.id}/teacher-feedback/${form.dataset.reviewSubmission}-${uniqueName}${extension}`
      const { error: uploadError } = await sb.storage.from('project-submissions').upload(teacherFilePath, file, {
        contentType: getUploadMimeType(file),
        upsert: false
      })
      if (uploadError) throw uploadError
    }

    const { error } = await sb.rpc('review_project_submission', {
      p_submission_id: form.dataset.reviewSubmission,
      p_decision: decision,
      p_feedback: feedback,
      p_teacher_file_path: teacherFilePath,
      p_teacher_file_name: file?.name || null,
      p_teacher_mime_type: file ? getUploadMimeType(file) : null,
      p_teacher_file_size: file?.size || null
    })
    if (error) throw error
    showToast(decision === 'passed' ? 'ส่งผลตรวจและเปิดหัวข้อถัดไปแล้ว' : 'ส่งความคิดเห็นและไฟล์ให้นักเรียนแก้ไขแล้ว')
    await loadWorkspace(false)
  } catch (error) {
    if (teacherFilePath) await sb.storage.from('project-submissions').remove([teacherFilePath])
    showToast(readableError(error), true)
  } finally {
    mutationInProgress = false
    form.querySelectorAll('button').forEach(item => { item.disabled = false })
    button.textContent = originalButtonText
  }
}

async function sendMessage(event) {
  event.preventDefault()
  const input = document.getElementById('messageInput')
  const button = document.getElementById('sendMessageButton')
  const body = input.value.trim()
  if (!body) return
  setButtonBusy(button, true, '...')
  const { error } = await sb.rpc('send_project_message', { p_project_id: Number(projectId), p_body: body })
  setButtonBusy(button, false, 'ส่ง')
  if (error) return showToast(readableError(error), true)
  input.value = ''
  await loadWorkspace(false)
}

function renderMessages(previousCount) {
  const messages = workspace.messages || []
  const list = document.getElementById('messageList')
  list.innerHTML = messages.map(message => {
    const own = message.sender_id === workspace.viewer.id
    const role = message.sender_role === 'teacher' ? 'ครู' : 'นักเรียน'
    return `<article class="message ${own ? 'own' : ''}">
      <div class="message-author">${own ? 'คุณ' : escapeHtml(message.sender_name || role)} • ${role}</div>
      <div class="message-bubble">${escapeHtml(message.body)}</div>
      <div class="message-time">${formatDateTime(message.created_at)}</div>
    </article>`
  }).join('')
  document.getElementById('messagesEmpty').hidden = messages.length > 0
  if (messages.length !== previousCount) list.scrollTop = list.scrollHeight
}

async function openSubmissionFile(path, originalName, button) {
  const originalButtonText = button.textContent
  setButtonBusy(button, true, 'กำลังเตรียมไฟล์...')
  try {
    const { data: fileBlob, error } = await sb.storage.from('project-submissions').download(path)
    if (error || !fileBlob) throw error || new Error('File download failed')

    const objectUrl = URL.createObjectURL(fileBlob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = safeDownloadName(originalName, path)
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500)
  } catch (error) {
    console.error(error)
    showToast('ดาวน์โหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', true)
  } finally {
    setButtonBusy(button, false, originalButtonText)
  }
}

function setButtonBusy(button, busy, text) {
  button.disabled = busy
  button.textContent = text
}

function isEditing() {
  return mutationInProgress || document.activeElement?.matches('input, textarea') || !document.getElementById('taskForm').hidden || !document.getElementById('deadlineForm').hidden
}

function getSafeExtension(name) {
  const match = String(name).toLowerCase().match(/\.[a-z0-9]{1,8}$/)
  return match ? match[0] : ''
}

function safeDownloadName(originalName, path) {
  const fallback = String(path || '').split('/').pop() || 'งานที่ส่ง'
  const cleaned = String(originalName || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
  if (!cleaned) return 'งานที่ส่ง'

  const extension = getSafeExtension(cleaned)
  const baseName = extension ? cleaned.slice(0, -extension.length) : cleaned
  return `${baseName.slice(0, 180) || 'งานที่ส่ง'}${extension}`
}

function getUploadMimeType(file) {
  const extension = getSafeExtension(file.name)
  const mimeByExtension = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.zip': 'application/zip',
    '.txt': 'text/plain'
  }
  return mimeByExtension[extension] || file.type || 'text/plain'
}

function normalizeProjectStatus(status) { return ['approved', 'rejected'].includes(status) ? status : 'pending' }
function projectStatusLabel(status) { return status === 'approved' ? 'อนุมัติแล้ว' : status === 'rejected' ? 'ไม่ผ่านการอนุมัติ' : 'รออนุมัติ' }
function clampProgress(value) { const number = Number(value); return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 0 }

function formatDateTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatLearningDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  if (hours) return `เรียน ${hours} ชม. ${minutes} นาที`
  if (minutes) return `เรียน ${minutes} นาที`
  return `เรียน ${value} วินาที`
}

function getDeadlineState(dateValue) {
  const today = new Date()
  const todayValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const days = Math.round((Date.parse(`${dateValue}T00:00:00Z`) - Date.parse(`${todayValue}T00:00:00Z`)) / 86400000)
  if (days < 0) return { kind: 'overdue', label: `เลยกำหนดแล้ว ${Math.abs(days)} วัน` }
  if (days === 0) return { kind: 'today', label: 'ครบกำหนดวันนี้' }
  return { kind: 'upcoming', label: `เหลืออีก ${days} วัน` }
}

function formatDeadlineDate(dateValue) {
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${dateValue}T00:00:00`))
}

function readableError(error) {
  const message = String(error?.message || error || '')
  const translations = [
    ['You do not have access to this project', 'บัญชีนี้ไม่มีสิทธิ์เข้าถึงพื้นที่โครงงาน'],
    ['Only the assigned advisor', 'เฉพาะครูที่ปรึกษาของโครงงานเท่านั้นที่ดำเนินการนี้ได้'],
    ['Complete the previous task first', 'ต้องผ่านหัวข้อก่อนหน้าก่อน'],
    ['waiting for advisor review', 'งานรอบนี้กำลังรอครูตรวจ'],
    ['already passed', 'หัวข้อนี้ผ่านแล้ว'],
    ['File is larger than 20 MB', 'ไฟล์มีขนาดเกิน 20 MB'],
    ['Feedback is required', 'กรุณาระบุความคิดเห็นสำหรับการแก้ไข'],
    ['Only the assigned advisor can update project deadlines', 'เฉพาะครูที่ปรึกษาของโครงงานเท่านั้นที่กำหนดวันส่งได้'],
    ['Proposal deadline is required', 'กรุณากำหนดวันส่งข้อเสนอโครงงาน'],
    ['Competition name and deadline must be provided together', 'กรุณาระบุชื่อการแข่งขันและกำหนดส่งให้ครบ'],
    ['Competition deadline must be on or after proposal deadline', 'กำหนดส่งแข่งขันต้องไม่อยู่ก่อนวันส่งข้อเสนอ']
  ]
  return translations.find(([source]) => message.includes(source))?.[1] || message || 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่'
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast')
  toast.textContent = message
  toast.className = `toast show${isError ? ' error' : ''}`
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.className = 'toast' }, 3200)
}

function showPageError(message) {
  document.getElementById('pageLoading').hidden = true
  document.getElementById('workspaceContent').hidden = true
  document.getElementById('pageErrorText').textContent = message
  document.getElementById('pageError').hidden = false
}

window.addEventListener('pagehide', () => { if (pollTimer) window.clearInterval(pollTimer) })
