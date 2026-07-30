const SUPABASE_URL = 'https://klszrjhdpvsiktddzpga.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtsc3pyamhkcHZzaWt0ZGR6cGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDMzODMsImV4cCI6MjA4NzA3OTM4M30.zcK4gseuAMxweSWEGWYSuUcPui0EJgOcE66XsKw6wUM'
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const pageMode = document.body.dataset.mode

let currentUserId = ''

init()

async function init() {
  try {
    const { data: { user }, error: authError } = await sb.auth.getUser()
    if (authError || !user) {
      location.href = 'index.html'
      return
    }

    currentUserId = user.id

    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('first_name, last_name, role')
      .eq('id', user.id)
      .single()

    if (profileError || !profile || profile.role !== 'student') {
      throw new Error('หน้านี้สำหรับบัญชีนักเรียนเท่านั้น')
    }

    const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim()
    document.getElementById('profileName').textContent = fullName ? `ของ ${fullName}` : ''

    const projects = pageMode === 'leader'
      ? await loadLeaderProjects(user.id)
      : await loadMemberProjects(user.id)

    renderProjects(projects)
    renderStats(projects)
  } catch (error) {
    console.error(error)
    document.getElementById('loading').style.display = 'none'
    document.getElementById('emptyState').style.display = 'block'
    document.getElementById('emptyState').innerHTML = `<strong>โหลดข้อมูลไม่สำเร็จ</strong>${escapeHtml(error.message || 'กรุณาลองใหม่อีกครั้ง')}`
  }
}

async function loadLeaderProjects(userId) {
  const { data: projects, error } = await sb
    .from('student_projects')
    .select('*')
    .eq('student_id', userId)
    .order('created_at', { ascending: false })

  if (error) throw error
  if (!projects?.length) return []

  const { data: members } = await sb
    .from('project_member')
    .select('project_id, profiles(first_name, last_name)')
    .in('project_id', projects.map(project => project.id))

  const membersMap = {}
  ;(members || []).forEach(member => {
    if (!membersMap[member.project_id]) membersMap[member.project_id] = []
    if (member.profiles) {
      membersMap[member.project_id].push(`${member.profiles.first_name || ''} ${member.profiles.last_name || ''}`.trim())
    }
  })

  return projects.map(project => ({ ...project, memberNames: membersMap[project.id] || [] }))
}

async function loadMemberProjects(userId) {
  const { data, error } = await sb
    .from('project_member')
    .select('student_projects (*)')
    .eq('student_id', userId)

  if (error) throw error

  const uniqueProjects = new Map()
  ;(data || []).forEach(row => {
    const project = row.student_projects
    if (project && project.student_id !== userId) uniqueProjects.set(project.id, project)
  })

  return Array.from(uniqueProjects.values()).sort((a, b) =>
    new Date(b.created_at || 0) - new Date(a.created_at || 0)
  )
}

function renderStats(projects) {
  document.getElementById('totalCount').textContent = projects.length
  document.getElementById('pendingCount').textContent = projects.filter(project => normalizeStatus(project.status) === 'pending').length
  document.getElementById('approvedCount').textContent = projects.filter(project => project.status === 'approved').length
  document.getElementById('rejectedCount').textContent = projects.filter(project => project.status === 'rejected').length
  document.getElementById('projectCountLabel').textContent = `${projects.length} โครงงาน`
}

function renderProjects(projects) {
  const loading = document.getElementById('loading')
  const grid = document.getElementById('projectGrid')
  const emptyState = document.getElementById('emptyState')
  loading.style.display = 'none'

  if (!projects.length) {
    emptyState.style.display = 'block'
    return
  }

  grid.innerHTML = projects.map(project => {
    const status = normalizeStatus(project.status)
    const progress = clampProgress(project.progress)
    const memberText = project.memberNames?.length ? project.memberNames.join(', ') : 'ยังไม่มีสมาชิก'
    const secondaryMeta = pageMode === 'leader'
      ? `<div>👥 สมาชิก: ${escapeHtml(memberText)}</div>`
      : `<div>👑 หัวหน้ากลุ่ม: ${escapeHtml(project.student_name || '-')}</div>`
    const actions = pageMode === 'leader'
      ? `<div class="card-actions">
          <button class="edit-btn" type="button" data-edit-id="${escapeHtml(project.id)}">แก้ไข</button>
          <button class="delete-btn" type="button" data-delete-id="${escapeHtml(project.id)}" data-title="${escapeHtml(project.title || '')}">ลบ</button>
        </div>`
      : ''

    return `
      <article class="project-card ${status}" data-project-id="${escapeHtml(project.id)}" tabindex="0" role="link">
        <div class="card-top">
          <span class="category">${escapeHtml(project.category || 'ไม่ระบุหมวดหมู่')}</span>
          <span class="status ${status}">${statusLabel(status)}</span>
        </div>
        <h3>${escapeHtml(project.title || 'ไม่มีชื่อโครงงาน')}</h3>
        <div class="project-meta">
          <div>👨‍🏫 ครูที่ปรึกษา: ${escapeHtml(project.advisor || '-')}</div>
          ${secondaryMeta}
        </div>
        ${renderProjectDeadlines(project)}
        <p class="project-description">${escapeHtml(project.description || 'ไม่มีรายละเอียด')}</p>
        <div class="progress-head"><span>ความคืบหน้า</span><strong>${progress}%</strong></div>
        <div class="progress-bar"><span style="width:${progress}%"></span></div>
        ${actions}
      </article>
    `
  }).join('')

  grid.querySelectorAll('.project-card').forEach(card => {
    card.addEventListener('click', event => {
      if (event.target.closest('button')) return
      location.href = `projectDetail.html?id=${encodeURIComponent(card.dataset.projectId)}`
    })
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter') location.href = `projectDetail.html?id=${encodeURIComponent(card.dataset.projectId)}`
    })
  })

  grid.querySelectorAll('[data-edit-id]').forEach(button => {
    button.addEventListener('click', () => {
      location.href = `editProject.html?id=${encodeURIComponent(button.dataset.editId)}`
    })
  })

  grid.querySelectorAll('[data-delete-id]').forEach(button => {
    button.addEventListener('click', () => deleteProject(button.dataset.deleteId, button.dataset.title))
  })
}

function renderProjectDeadlines(project) {
  const proposal = project.proposal_due_date
    ? `<span class="deadline-pill ${deadlineClass(project.proposal_due_date)}">📝 ส่งข้อเสนอ ${formatDeadlineDate(project.proposal_due_date)}</span>`
    : '<span class="deadline-pill unset">📝 ยังไม่กำหนดวันส่งข้อเสนอ</span>'
  const competition = project.competition_due_date
    ? `<span class="deadline-pill competition ${deadlineClass(project.competition_due_date)}">🏆 ${escapeHtml(project.competition_name || 'ส่งแข่งขัน')} ${formatDeadlineDate(project.competition_due_date)}</span>`
    : ''
  return `<div class="project-deadlines">${proposal}${competition}</div>`
}

function deadlineClass(dateValue) {
  const today = new Date()
  const todayValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return dateValue < todayValue ? 'overdue' : ''
}

function formatDeadlineDate(dateValue) {
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${dateValue}T00:00:00`))
}

async function deleteProject(projectId, projectTitle) {
  const result = await Swal.fire({
    title: 'ยืนยันการลบ?',
    text: `ต้องการลบโครงงาน “${projectTitle}” ใช่หรือไม่`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#bd5b50',
    cancelButtonColor: '#8b8074',
    confirmButtonText: 'ลบโครงงาน',
    cancelButtonText: 'ยกเลิก'
  })

  if (!result.isConfirmed) return

  await sb.from('project_member').delete().eq('project_id', projectId)
  const { error } = await sb
    .from('student_projects')
    .delete()
    .eq('id', projectId)
    .eq('student_id', currentUserId)

  if (error) {
    await Swal.fire('ลบไม่สำเร็จ', error.message, 'error')
    return
  }

  await Swal.fire({ title: 'ลบโครงงานแล้ว', icon: 'success', confirmButtonColor: '#648468' })
  location.reload()
}

function normalizeStatus(status) {
  return ['approved', 'rejected'].includes(status) ? status : 'pending'
}

function statusLabel(status) {
  if (status === 'approved') return 'อนุมัติแล้ว'
  if (status === 'rejected') return 'ไม่ผ่าน'
  return 'รออนุมัติ'
}

function clampProgress(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0
}

function escapeHtml(value) {
  const element = document.createElement('div')
  element.textContent = String(value)
  return element.innerHTML
}

async function logout() {
  await sb.auth.signOut()
  location.href = 'index.html'
}
