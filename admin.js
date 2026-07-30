const SUPABASE_URL = 'https://klszrjhdpvsiktddzpga.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtsc3pyamhkcHZzaWt0ZGR6cGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDMzODMsImV4cCI6MjA4NzA3OTM4M30.zcK4gseuAMxweSWEGWYSuUcPui0EJgOcE66XsKw6wUM'
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

let allUsers = []
let currentAdminId = ''
let projectsRequestId = 0

document.getElementById('menuToggle').addEventListener('click', () => document.body.classList.toggle('menu-open'))
document.getElementById('searchInput').addEventListener('input', renderUsers)
document.getElementById('roleFilter').addEventListener('change', renderUsers)
document.getElementById('editForm').addEventListener('submit', saveUser)

init()

async function init() {
  try {
    const { data: { user }, error: authError } = await sb.auth.getUser()
    if (authError || !user) {
      location.href = 'index.html'
      return
    }

    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('first_name, last_name, role')
      .eq('id', user.id)
      .single()

    if (profileError || profile?.role !== 'admin') {
      await Swal.fire({ icon: 'error', title: 'ไม่มีสิทธิ์เข้าถึง', text: 'หน้านี้สำหรับผู้ดูแลระบบเท่านั้น', confirmButtonColor: '#6f8f72' })
      location.href = 'index.html'
      return
    }

    currentAdminId = user.id
    const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'ผู้ดูแลระบบ'
    document.getElementById('adminName').textContent = fullName
    document.getElementById('adminEmail').textContent = user.email || ''
    document.querySelector('.admin-avatar').textContent = fullName.charAt(0).toUpperCase()
    await refreshData()
  } catch (error) {
    showError(error)
  }
}

async function refreshData() {
  setLoading(true)
  try {
    const [usersResult, projectsResult] = await Promise.all([
      invokeAdmin('list_users'),
      sb.from('student_projects').select('id, status')
    ])

    allUsers = usersResult.users || []
    const projects = projectsResult.data || []
    document.getElementById('memberCount').textContent = allUsers.length
    document.getElementById('studentCount').textContent = allUsers.filter(user => user.role === 'student').length
    document.getElementById('teacherCount').textContent = allUsers.filter(user => user.role === 'teacher').length
    document.getElementById('projectCount').textContent = projects.length
    renderUsers()
  } catch (error) {
    showError(error)
  } finally {
    setLoading(false)
  }
}

function renderUsers() {
  const term = document.getElementById('searchInput').value.trim().toLocaleLowerCase('th-TH')
  const role = document.getElementById('roleFilter').value
  const users = allUsers.filter(user => {
    const haystack = `${user.first_name || ''} ${user.last_name || ''} ${user.email || ''}`.toLocaleLowerCase('th-TH')
    return (!term || haystack.includes(term)) && (role === 'all' || user.role === role)
  })

  const table = document.getElementById('usersTable')
  const empty = document.getElementById('emptyUsers')
  document.getElementById('resultSummary').textContent = `แสดง ${users.length} จาก ${allUsers.length} บัญชี`
  table.hidden = users.length === 0
  empty.hidden = users.length !== 0

  document.getElementById('usersBody').innerHTML = users.map(user => {
    const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'ยังไม่ได้ระบุชื่อ'
    const isSelf = user.id === currentAdminId
    const grade = user.role === 'student' ? `${user.grade || '-'} / ${user.no || '-'}` : '-'
    return `
      <tr>
        <td><div class="user-cell"><span class="user-avatar">${escapeHtml(name.charAt(0).toUpperCase() || '?')}</span><div><button class="user-name-button" type="button" data-projects-for="${escapeHtml(user.id)}">${escapeHtml(name)}${isSelf ? ' (คุณ)' : ''}</button><small>${escapeHtml(user.email || '-')}</small></div></div></td>
        <td><span class="role-badge role-${escapeHtml(normalizeRole(user.role))}">${roleLabel(user.role)}</span></td>
        <td>${escapeHtml(grade)}</td>
        <td class="last-login">${formatDate(user.last_sign_in_at)}</td>
        <td><div class="row-actions">
          <button class="edit-user" type="button" data-edit="${escapeHtml(user.id)}">✏️ แก้ไข</button>
          <button class="reset-user" type="button" data-reset="${escapeHtml(user.id)}">🔑 รีเซ็ตรหัสผ่าน</button>
          <button class="delete-user" type="button" data-delete="${escapeHtml(user.id)}" ${isSelf ? 'disabled title="ไม่สามารถลบบัญชีที่กำลังใช้งาน"' : ''}>🗑️ ลบ</button>
        </div></td>
      </tr>`
  }).join('')

  document.querySelectorAll('[data-projects-for]').forEach(button => button.addEventListener('click', () => openProjectsDialog(button.dataset.projectsFor)))
  document.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openEditDialog(button.dataset.edit)))
  document.querySelectorAll('[data-reset]').forEach(button => button.addEventListener('click', () => resetPassword(button.dataset.reset)))
  document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => deleteUser(button.dataset.delete)))
}

async function openProjectsDialog(userId) {
  const user = allUsers.find(item => item.id === userId)
  if (!user) return

  const requestId = ++projectsRequestId
  const dialog = document.getElementById('projectsDialog')
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'ยังไม่ได้ระบุชื่อ'
  const studentInfo = user.role === 'student' && (user.grade || user.no)
    ? ` • ชั้น ${user.grade || '-'} / เลขที่ ${user.no || '-'}`
    : ''

  document.getElementById('projectsDialogTitle').textContent = name
  document.getElementById('projectsDialogMeta').textContent = `${roleLabel(user.role)} • ${user.email || '-'}${studentInfo}`
  document.getElementById('userProjectCount').textContent = '0'
  document.getElementById('userProgressAverage').textContent = '0%'
  document.getElementById('userProjectsList').innerHTML = ''
  document.getElementById('userProjectsLoading').hidden = false
  document.getElementById('userProjectsEmpty').hidden = true
  document.getElementById('userProjectsError').hidden = true

  if (!dialog.open) dialog.showModal()

  try {
    const projects = await loadProjectsForUser(user)
    if (requestId !== projectsRequestId) return
    renderUserProjects(projects)
  } catch (error) {
    if (requestId !== projectsRequestId) return
    console.error(error)
    document.getElementById('userProjectsLoading').hidden = true
    const errorBox = document.getElementById('userProjectsError')
    errorBox.textContent = error.message || 'โหลดข้อมูลโครงงานไม่สำเร็จ'
    errorBox.hidden = false
  }
}

function closeProjectsDialog() {
  projectsRequestId += 1
  document.getElementById('projectsDialog').close()
}

async function loadProjectsForUser(user) {
  const fields = 'id, title, category, advisor, status, progress, created_at, student_id'

  if (user.role === 'student') {
    const [leaderResult, memberResult] = await Promise.all([
      sb.from('student_projects').select(fields).eq('student_id', user.id),
      sb.from('project_member').select(`student_projects (${fields})`).eq('student_id', user.id)
    ])

    if (leaderResult.error) throw leaderResult.error
    if (memberResult.error) throw memberResult.error

    const projects = new Map()
    ;(leaderResult.data || []).forEach(project => projects.set(project.id, { ...project, participation: 'หัวหน้ากลุ่ม' }))
    ;(memberResult.data || []).forEach(row => {
      const project = row.student_projects
      if (project && !projects.has(project.id)) projects.set(project.id, { ...project, participation: 'สมาชิกกลุ่ม' })
    })
    return sortProjects(Array.from(projects.values()))
  }

  if (user.role === 'teacher') {
    const teacherName = `${user.first_name || ''} ${user.last_name || ''}`.trim()
    if (!teacherName) return []
    const { data, error } = await sb
      .from('student_projects')
      .select(fields)
      .eq('advisor', teacherName)
    if (error) throw error
    return sortProjects((data || []).map(project => ({ ...project, participation: 'ครูที่ปรึกษา' })))
  }

  return []
}

function renderUserProjects(projects) {
  const list = document.getElementById('userProjectsList')
  const empty = document.getElementById('userProjectsEmpty')
  document.getElementById('userProjectsLoading').hidden = true
  document.getElementById('userProjectCount').textContent = projects.length
  const average = projects.length
    ? Math.round(projects.reduce((sum, project) => sum + clampProgress(project.progress), 0) / projects.length)
    : 0
  document.getElementById('userProgressAverage').textContent = `${average}%`

  if (!projects.length) {
    empty.hidden = false
    list.innerHTML = ''
    return
  }

  empty.hidden = true
  list.innerHTML = projects.map(project => {
    const progress = clampProgress(project.progress)
    const status = normalizeProjectStatus(project.status)
    return `
      <article class="user-project-card">
        <div class="user-project-card-head">
          <div>
            <span class="project-participation">${escapeHtml(project.participation)}</span>
            <h3>${escapeHtml(project.title || 'ไม่มีชื่อโครงงาน')}</h3>
          </div>
          <span class="project-status project-status-${status}">${projectStatusLabel(status)}</span>
        </div>
        <div class="user-project-meta">${escapeHtml(project.category || 'ไม่ระบุหมวดหมู่')} • ครูที่ปรึกษา ${escapeHtml(project.advisor || '-')}</div>
        <div class="project-progress-head"><span>ความคืบหน้า</span><strong>${progress}%</strong></div>
        <div class="project-progress-bar" role="progressbar" aria-label="ความคืบหน้าโครงงาน" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div>
      </article>`
  }).join('')
}

function sortProjects(projects) {
  return projects.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
}

function normalizeProjectStatus(status) { return ['approved', 'rejected'].includes(status) ? status : 'pending' }
function projectStatusLabel(status) { return ({ pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่ผ่าน' })[status] }
function clampProgress(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0
}

function openEditDialog(userId) {
  const user = allUsers.find(item => item.id === userId)
  if (!user) return
  document.getElementById('editUserId').value = user.id
  document.getElementById('editFirstName').value = user.first_name || ''
  document.getElementById('editLastName').value = user.last_name || ''
  document.getElementById('editEmail').value = user.email || ''
  document.getElementById('editRole').value = normalizeRole(user.role)
  document.getElementById('editRole').disabled = user.id === currentAdminId
  document.getElementById('editGrade').value = user.grade || ''
  document.getElementById('editNo').value = user.no || ''
  document.getElementById('editDialog').showModal()
}

function closeEditDialog() {
  document.getElementById('editDialog').close()
}

async function saveUser(event) {
  event.preventDefault()
  const button = document.getElementById('saveUserBtn')
  button.disabled = true
  button.textContent = 'กำลังบันทึก...'
  try {
    await invokeAdmin('update_user', {
      user_id: document.getElementById('editUserId').value,
      email: document.getElementById('editEmail').value.trim(),
      first_name: document.getElementById('editFirstName').value.trim(),
      last_name: document.getElementById('editLastName').value.trim(),
      role: document.getElementById('editRole').disabled ? 'admin' : document.getElementById('editRole').value,
      grade: document.getElementById('editGrade').value.trim() || null,
      no: document.getElementById('editNo').value ? Number(document.getElementById('editNo').value) : null
    })
    closeEditDialog()
    await Swal.fire({ icon: 'success', title: 'บันทึกข้อมูลแล้ว', timer: 1300, showConfirmButton: false })
    await refreshData()
  } catch (error) {
    showError(error)
  } finally {
    button.disabled = false
    button.textContent = 'บันทึกข้อมูล'
  }
}

async function resetPassword(userId) {
  const user = allUsers.find(item => item.id === userId)
  if (!user) return
  const temporaryPassword = generateTemporaryPassword()
  const result = await Swal.fire({
    title: 'ตั้งรหัสผ่านชั่วคราว',
    html: `บัญชี <strong>${escapeHtml(user.email || '')}</strong><br><small>ผู้ใช้ควรเปลี่ยนรหัสผ่านหลังเข้าสู่ระบบ</small>`,
    input: 'text', inputValue: temporaryPassword, inputLabel: 'รหัสผ่านใหม่',
    showCancelButton: true, confirmButtonText: 'รีเซ็ตรหัสผ่าน', cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#6f8f72', inputValidator: value => value.length < 8 ? 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' : undefined
  })
  if (!result.isConfirmed) return
  try {
    await invokeAdmin('reset_password', { user_id: userId, new_password: result.value })
    await Swal.fire({ icon: 'success', title: 'รีเซ็ตรหัสผ่านแล้ว', html: `รหัสผ่านชั่วคราว:<br><code class="temporary-password">${escapeHtml(result.value)}</code><br><small>กรุณาส่งรหัสนี้ให้เจ้าของบัญชีผ่านช่องทางที่ปลอดภัย</small>`, confirmButtonColor: '#6f8f72' })
  } catch (error) {
    showError(error)
  }
}

async function deleteUser(userId) {
  const user = allUsers.find(item => item.id === userId)
  if (!user || userId === currentAdminId) return
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email
  const result = await Swal.fire({
    icon: 'warning', title: 'ลบบัญชีสมาชิก?',
    html: `คุณกำลังจะลบ <strong>${escapeHtml(name || '')}</strong><br><small>ข้อมูลโครงงานที่บัญชีนี้เป็นเจ้าของจะถูกลบด้วย และไม่สามารถย้อนกลับได้</small>`,
    showCancelButton: true, confirmButtonText: 'ลบบัญชีถาวร', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#c95c50'
  })
  if (!result.isConfirmed) return
  try {
    await invokeAdmin('delete_user', { user_id: userId })
    await Swal.fire({ icon: 'success', title: 'ลบบัญชีแล้ว', timer: 1300, showConfirmButton: false })
    await refreshData()
  } catch (error) {
    showError(error)
  }
}

async function invokeAdmin(action, payload = {}) {
  const { data, error } = await sb.functions.invoke('admin-users', { body: { action, ...payload } })
  if (error) throw new Error(data?.error || error.message || 'คำสั่ง Admin ไม่สำเร็จ')
  if (!data?.ok) throw new Error(data?.error || 'คำสั่ง Admin ไม่สำเร็จ')
  return data
}

function setLoading(isLoading) {
  document.getElementById('adminLoading').hidden = !isLoading
  if (isLoading) document.getElementById('usersTable').hidden = true
}

function generateTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'
  const values = crypto.getRandomValues(new Uint32Array(14))
  return Array.from(values, value => alphabet[value % alphabet.length]).join('')
}

function normalizeRole(role) { return ['student', 'teacher', 'community', 'admin'].includes(role) ? role : 'community' }
function roleLabel(role) { return ({ student: 'นักเรียน', teacher: 'ครู', community: 'ชุมชน', admin: 'Admin' })[normalizeRole(role)] }
function formatDate(value) { return value ? new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'ยังไม่เคยเข้าใช้' }
function escapeHtml(value) { const element = document.createElement('div'); element.textContent = String(value); return element.innerHTML }
function showError(error) { console.error(error); Swal.fire({ icon: 'error', title: 'ดำเนินการไม่สำเร็จ', text: error.message || 'กรุณาลองใหม่อีกครั้ง', confirmButtonColor: '#6f8f72' }) }
async function logout() { await sb.auth.signOut(); location.href = 'index.html' }
