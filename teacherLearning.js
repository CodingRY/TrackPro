const SUPABASE_URL = 'https://klszrjhdpvsiktddzpga.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtsc3pyamhkcHZzaWt0ZGR6cGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDMzODMsImV4cCI6MjA4NzA3OTM4M30.zcK4gseuAMxweSWEGWYSuUcPui0EJgOcE66XsKw6wUM'
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

let students = []
let lessons = []
let progressRows = []

document.getElementById('studentSearch').addEventListener('input', renderReport)
init()

async function init() {
  try {
    const { data: { user }, error: authError } = await sb.auth.getUser()
    if (authError || !user) return redirectToLogin()

    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('first_name,last_name,role')
      .eq('id', user.id)
      .single()

    if (profileError || profile?.role !== 'teacher') {
      alert('หน้านี้สำหรับบัญชีครูที่ปรึกษาเท่านั้น')
      location.href = profile?.role === 'admin' ? 'admin.html' : 'dashboard.html'
      return
    }

    const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'ครูที่ปรึกษา'
    document.getElementById('accountName').textContent = fullName
    document.getElementById('accountAvatar').textContent = fullName.charAt(0).toUpperCase()

    const [studentResult, lessonResult] = await Promise.all([
      sb.rpc('get_advised_learning_students'),
      sb.from('learning_lessons').select('id,title,duration_seconds,unit_title,unit_order,topic_title,topic_order,sort_order').eq('is_published', true)
        .order('unit_order').order('unit_title')
        .order('topic_order').order('topic_title')
        .order('sort_order').order('created_at')
    ])

    if (studentResult.error) throw studentResult.error
    if (lessonResult.error) throw lessonResult.error
    students = Array.isArray(studentResult.data) ? studentResult.data : []
    lessons = lessonResult.data || []

    if (students.length) {
      const { data, error } = await sb
        .from('learning_progress')
        .select('student_id,lesson_id,watched_seconds,completed,updated_at')
        .in('student_id', students.map(student => student.id))
      if (error) throw error
      progressRows = data || []
    }

    document.getElementById('reportLoading').hidden = true
    renderStats()
    renderReport()
  } catch (error) {
    console.error(error)
    document.getElementById('reportLoading').hidden = true
    document.getElementById('reportErrorText').textContent = error.message || 'กรุณาลองใหม่อีกครั้ง'
    document.getElementById('reportError').hidden = false
  }
}

function renderStats() {
  const summaries = students.map(getStudentSummary)
  const average = summaries.length
    ? Math.round(summaries.reduce((sum, item) => sum + item.percent, 0) / summaries.length)
    : 0
  const totalWatch = summaries.reduce((sum, item) => sum + item.watchedSeconds, 0)

  document.getElementById('studentCount').textContent = students.length
  document.getElementById('averageProgress').textContent = `${average}%`
  document.getElementById('totalWatchTime').textContent = formatDuration(totalWatch)
}

function renderReport() {
  const search = document.getElementById('studentSearch').value.trim().toLocaleLowerCase('th')
  const filtered = students.filter(student => {
    const searchable = [student.first_name, student.last_name, student.grade, ...(student.project_titles || [])].join(' ').toLocaleLowerCase('th')
    return !search || searchable.includes(search)
  })

  document.getElementById('reportSummary').textContent = `แสดง ${filtered.length} จาก ${students.length} คน • ${lessons.length} บทเรียนที่เผยแพร่`
  document.getElementById('studentEmpty').hidden = students.length > 0

  const list = document.getElementById('studentProgressList')
  list.innerHTML = filtered.map(student => renderStudentCard(student)).join('')
  list.querySelectorAll('[data-student-toggle]').forEach(button => {
    button.addEventListener('click', () => button.closest('.student-progress-card').classList.toggle('open'))
  })
}

function renderStudentCard(student) {
  const fullName = `${student.first_name || ''} ${student.last_name || ''}`.trim() || 'ไม่ระบุชื่อ'
  const summary = getStudentSummary(student)
  const projectText = (student.project_titles || []).join(', ') || 'ยังไม่ระบุโครงงาน'
  const classText = [student.grade ? `ชั้น ${student.grade}` : '', student.no ? `เลขที่ ${student.no}` : ''].filter(Boolean).join(' • ') || 'ไม่ระบุชั้น'

  const details = lessons.length
    ? lessons.map(lesson => {
        const row = progressRows.find(item => item.student_id === student.id && item.lesson_id === lesson.id)
        const watched = Math.min(Number(row?.watched_seconds) || 0, lesson.duration_seconds)
        const percent = lesson.duration_seconds ? Math.min(100, Math.round(watched / lesson.duration_seconds * 100)) : 0
        return `<div class="lesson-progress-row">
          <div><strong>${escapeHtml(lesson.title)}</strong><br><small>${escapeHtml(lesson.unit_title || 'หน่วยการเรียนรู้ทั่วไป')} • ${escapeHtml(lesson.topic_title || 'หัวข้อทั่วไป')}<br>เรียนแล้ว ${formatDuration(watched)} จาก ${formatDuration(lesson.duration_seconds)}</small></div>
          <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
          <strong>${percent}%</strong>
        </div>`
      }).join('')
    : '<p class="section-note">ยังไม่มีบทเรียนที่เผยแพร่</p>'

  return `<article class="student-progress-card">
    <button class="student-summary" type="button" data-student-toggle="${student.id}" aria-label="ดูรายละเอียดของ ${escapeHtml(fullName)}">
      <span class="student-person"><span class="student-avatar">${escapeHtml(fullName.charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(fullName)}</strong><small>${escapeHtml(classText)} • เรียนแล้ว ${formatDuration(summary.watchedSeconds)}</small></span></span>
      <span class="student-projects">โครงงาน: ${escapeHtml(projectText)}</span>
      <span class="student-progress-mini"><span class="progress-label"><span>${summary.completedCount}/${lessons.length} บท</span></span><span class="progress-track"><span class="progress-fill" style="width:${summary.percent}%"></span></span></span>
      <span class="student-percent">${summary.percent}%</span>
      <span aria-hidden="true">⌄</span>
    </button>
    <div class="student-detail">${details}</div>
  </article>`
}

function getStudentSummary(student) {
  const totalRequired = lessons.reduce((sum, lesson) => sum + lesson.duration_seconds, 0)
  let watchedSeconds = 0
  let completedCount = 0
  lessons.forEach(lesson => {
    const row = progressRows.find(item => item.student_id === student.id && item.lesson_id === lesson.id)
    watchedSeconds += Math.min(Number(row?.watched_seconds) || 0, lesson.duration_seconds)
    if (row?.completed) completedCount += 1
  })
  return {
    watchedSeconds,
    completedCount,
    percent: totalRequired ? Math.min(100, Math.round(watchedSeconds / totalRequired * 100)) : 0
  }
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  if (hours) return `${hours} ชม. ${minutes} นาที`
  if (minutes) return `${minutes} นาที`
  return `${value} วินาที`
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character])
}

function redirectToLogin() { location.href = 'index.html' }
