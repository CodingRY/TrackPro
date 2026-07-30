const SUPABASE_URL = 'https://klszrjhdpvsiktddzpga.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtsc3pyamhkcHZzaWt0ZGR6cGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDMzODMsImV4cCI6MjA4NzA3OTM4M30.zcK4gseuAMxweSWEGWYSuUcPui0EJgOcE66XsKw6wUM'
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

let currentUser = null
let lessons = []
let units = []
let topics = []

document.getElementById('lessonForm').addEventListener('submit', saveLesson)
document.getElementById('cancelEdit').addEventListener('click', resetForm)
document.getElementById('addUnitButton').addEventListener('click', addUnit)
document.getElementById('addTopicButton').addEventListener('click', addTopic)
document.getElementById('unitSelect').addEventListener('change', () => renderLessonTopicOptions())
init()

async function init() {
  const { data: { user }, error: authError } = await sb.auth.getUser()
  if (authError || !user) return redirectToLogin()

  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('first_name,last_name,role')
    .eq('id', user.id)
    .single()

  if (profileError || profile?.role !== 'admin') {
    alert('เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการบทเรียนได้')
    location.href = profile?.role === 'teacher' ? 'dashboard.html' : 'index.html'
    return
  }

  currentUser = user
  const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'ผู้ดูแลระบบ'
  document.getElementById('accountName').textContent = fullName
  document.getElementById('accountAvatar').textContent = fullName.charAt(0).toUpperCase()
  document.getElementById('accountRole').textContent = 'ผู้ดูแลระบบ'

  await loadLessons()
}

async function loadLessons(preferredSelections = {}) {
  document.getElementById('lessonLoading').hidden = false
  document.getElementById('lessonEmpty').hidden = true

  const [lessonResult, unitResult, topicResult] = await Promise.all([
    sb.from('learning_lessons').select('*')
      .order('unit_order').order('unit_title')
      .order('topic_order').order('topic_title')
      .order('sort_order').order('created_at'),
    sb.from('learning_units').select('*').order('sort_order').order('title').order('created_at'),
    sb.from('learning_topics').select('*').order('unit_id').order('sort_order').order('title').order('created_at')
  ])

  document.getElementById('lessonLoading').hidden = true
  const error = lessonResult.error || unitResult.error || topicResult.error
  if (error) {
    showToast(error.message || 'โหลดข้อมูลบทเรียนไม่สำเร็จ', true)
    return
  }

  lessons = lessonResult.data || []
  units = unitResult.data || []
  topics = topicResult.data || []
  renderCatalogMenus(preferredSelections)
  renderLessons()
}

async function addUnit() {
  const button = document.getElementById('addUnitButton')
  const titleInput = document.getElementById('newUnitTitle')
  const title = titleInput.value.trim()
  if (!title) return showToast('กรุณาพิมพ์ชื่อหน่วยการเรียนรู้', true)

  button.disabled = true
  const { data, error } = await sb.from('learning_units').insert({
    title,
    sort_order: clampOrder(document.getElementById('newUnitOrder').value),
    created_by: currentUser.id,
    updated_at: new Date().toISOString()
  }).select('id').single()
  button.disabled = false

  if (error) return showToast(error.code === '23505' ? 'มีชื่อหน่วยนี้แล้ว' : error.message || 'เพิ่มหน่วยไม่สำเร็จ', true)

  titleInput.value = ''
  document.getElementById('newUnitOrder').value = '0'
  showToast('เพิ่มหน่วยการเรียนรู้แล้ว กรุณาเพิ่มหัวข้อในหน่วยนี้')
  await loadLessons({ lessonUnitId: data.id, topicUnitId: data.id })
}

async function addTopic() {
  const button = document.getElementById('addTopicButton')
  const unitId = document.getElementById('topicUnitSelect').value
  const titleInput = document.getElementById('newTopicTitle')
  const title = titleInput.value.trim()
  if (!unitId) return showToast('กรุณาเพิ่มหน่วยการเรียนรู้ก่อน', true)
  if (!title) return showToast('กรุณาพิมพ์ชื่อหัวข้อ', true)

  button.disabled = true
  const { data, error } = await sb.from('learning_topics').insert({
    unit_id: unitId,
    title,
    sort_order: clampOrder(document.getElementById('newTopicOrder').value),
    created_by: currentUser.id,
    updated_at: new Date().toISOString()
  }).select('id').single()
  button.disabled = false

  if (error) return showToast(error.code === '23505' ? 'มีหัวข้อนี้ในหน่วยแล้ว' : error.message || 'เพิ่มหัวข้อไม่สำเร็จ', true)

  titleInput.value = ''
  document.getElementById('newTopicOrder').value = '0'
  showToast('เพิ่มหัวข้อแล้ว สามารถเลือกในฟอร์มบทเรียนได้ทันที')
  await loadLessons({ lessonUnitId: unitId, topicUnitId: unitId, lessonTopicId: data.id })
}

function renderLessons() {
  const publishedCount = lessons.filter(lesson => lesson.is_published).length
  document.getElementById('lessonSummary').textContent = `${lessons.length} บทเรียน • เผยแพร่แล้ว ${publishedCount} บท`
  document.getElementById('lessonEmpty').hidden = lessons.length > 0

  const lessonNumbers = new Map(lessons.map((lesson, index) => [lesson.id, index + 1]))
  document.getElementById('managedLessons').innerHTML = groupLessons(lessons).map(unit => `
    <section class="manage-unit-group">
      <header class="manage-unit-header">
        <span>หน่วยการเรียนรู้ • ลำดับ ${unit.order}</span>
        <h3>${escapeHtml(unit.title)}</h3>
      </header>
      ${unit.topics.map(topic => `
        <div class="manage-topic-group">
          <div class="manage-topic-header"><strong>${escapeHtml(topic.title)}</strong><span>ลำดับหัวข้อ ${topic.order}</span></div>
          ${topic.lessons.map(lesson => `
            <article class="managed-lesson">
              <img class="lesson-thumb" src="https://img.youtube.com/vi/${encodeURIComponent(lesson.youtube_video_id)}/mqdefault.jpg" alt="ภาพตัวอย่าง ${escapeHtml(lesson.title)}">
              <div>
                <h3>บทที่ ${lessonNumbers.get(lesson.id)} • ${escapeHtml(lesson.title)}</h3>
                <p>${formatDuration(lesson.duration_seconds)} • ลำดับบทเรียน ${lesson.sort_order}</p>
                <span class="status-badge ${lesson.is_published ? '' : 'draft'}">${lesson.is_published ? 'เผยแพร่แล้ว' : 'ฉบับร่าง'}</span>
              </div>
              <div class="item-actions">
                <button class="soft-btn" type="button" data-edit="${lesson.id}">แก้ไข</button>
                <button class="danger-btn" type="button" data-delete="${lesson.id}">ลบ</button>
              </div>
            </article>`).join('')}
        </div>`).join('')}
    </section>`).join('')

  document.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => editLesson(button.dataset.edit)))
  document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => deleteLesson(button.dataset.delete)))
}

async function saveLesson(event) {
  event.preventDefault()
  const saveButton = document.getElementById('saveLesson')
  const lessonId = document.getElementById('lessonId').value
  const youtubeUrl = document.getElementById('youtubeUrl').value.trim()
  const videoId = extractYouTubeId(youtubeUrl)
  const durationMinutes = Number(document.getElementById('durationMinutes').value)
  const selectedUnit = units.find(unit => unit.id === document.getElementById('unitSelect').value)
  const selectedTopic = topics.find(topic => topic.id === document.getElementById('topicSelect').value)

  if (!videoId) return showToast('ลิงก์ YouTube ไม่ถูกต้อง', true)
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return showToast('กรุณาระบุเวลาเรียนให้ถูกต้อง', true)
  if (!selectedUnit) return showToast('กรุณาเพิ่มและเลือกหน่วยการเรียนรู้', true)
  if (!selectedTopic || selectedTopic.unit_id !== selectedUnit.id) return showToast('กรุณาเพิ่มและเลือกหัวข้อในหน่วยนี้', true)

  const payload = {
    title: document.getElementById('lessonTitle').value.trim(),
    unit_title: selectedUnit.title,
    unit_order: clampOrder(selectedUnit.sort_order),
    topic_title: selectedTopic.title,
    topic_order: clampOrder(selectedTopic.sort_order),
    description: document.getElementById('lessonDescription').value.trim(),
    youtube_url: youtubeUrl,
    youtube_video_id: videoId,
    duration_seconds: Math.round(durationMinutes * 60),
    sort_order: Math.max(0, Number(document.getElementById('sortOrder').value) || 0),
    is_published: document.getElementById('isPublished').checked,
    updated_at: new Date().toISOString()
  }

  saveButton.disabled = true
  saveButton.textContent = 'กำลังบันทึก...'

  const result = lessonId
    ? await sb.from('learning_lessons').update(payload).eq('id', lessonId).select('id').single()
    : await sb.from('learning_lessons').insert({ ...payload, created_by: currentUser.id }).select('id').single()

  saveButton.disabled = false
  if (result.error) {
    saveButton.textContent = lessonId ? 'บันทึกการแก้ไข' : 'เพิ่มบทเรียน'
    showToast(result.error.message || 'บันทึกบทเรียนไม่สำเร็จ', true)
    return
  }

  showToast(lessonId ? 'แก้ไขบทเรียนเรียบร้อยแล้ว' : 'เพิ่มบทเรียนเรียบร้อยแล้ว')
  resetForm()
  await loadLessons()
}

function editLesson(lessonId) {
  const lesson = lessons.find(item => item.id === lessonId)
  if (!lesson) return

  document.getElementById('lessonId').value = lesson.id
  document.getElementById('lessonTitle').value = lesson.title
  const selectedUnit = units.find(unit => unit.title === lesson.unit_title)
  if (selectedUnit) document.getElementById('unitSelect').value = selectedUnit.id
  renderLessonTopicOptions()
  const selectedTopic = topics.find(topic => topic.unit_id === selectedUnit?.id && topic.title === lesson.topic_title)
  if (selectedTopic) document.getElementById('topicSelect').value = selectedTopic.id
  document.getElementById('youtubeUrl').value = lesson.youtube_url
  document.getElementById('durationMinutes').value = Number((lesson.duration_seconds / 60).toFixed(1))
  document.getElementById('sortOrder').value = lesson.sort_order
  document.getElementById('lessonDescription').value = lesson.description || ''
  document.getElementById('isPublished').checked = lesson.is_published
  document.getElementById('formTitle').textContent = 'แก้ไขบทเรียน'
  document.getElementById('saveLesson').textContent = 'บันทึกการแก้ไข'
  document.getElementById('cancelEdit').hidden = false
  document.getElementById('lessonTitle').focus()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function deleteLesson(lessonId) {
  const lesson = lessons.find(item => item.id === lessonId)
  if (!lesson || !confirm(`ยืนยันลบบทเรียน “${lesson.title}” และข้อมูลความคืบหน้าของบทเรียนนี้?`)) return

  const { data, error } = await sb.from('learning_lessons').delete().eq('id', lessonId).select('id')
  if (error || data?.length !== 1) {
    showToast(error?.message || 'ลบบทเรียนไม่สำเร็จ', true)
    return
  }

  if (document.getElementById('lessonId').value === lessonId) resetForm()
  showToast('ลบบทเรียนเรียบร้อยแล้ว')
  await loadLessons()
}

function resetForm() {
  document.getElementById('lessonForm').reset()
  document.getElementById('lessonId').value = ''
  document.getElementById('sortOrder').value = '0'
  document.getElementById('isPublished').checked = true
  if (units.length) document.getElementById('unitSelect').value = units[0].id
  renderLessonTopicOptions()
  document.getElementById('formTitle').textContent = 'เพิ่มบทเรียนใหม่'
  document.getElementById('saveLesson').textContent = 'เพิ่มบทเรียน'
  document.getElementById('cancelEdit').hidden = true
}

function renderCatalogMenus(preferredSelections = {}) {
  const unitSelect = document.getElementById('unitSelect')
  const topicUnitSelect = document.getElementById('topicUnitSelect')
  const currentLessonUnit = preferredSelections.lessonUnitId || unitSelect.value
  const currentTopicUnit = preferredSelections.topicUnitId || topicUnitSelect.value
  const unitOptions = units.length
    ? units.map(unit => `<option value="${unit.id}">${escapeHtml(unit.title)} (ลำดับ ${unit.sort_order})</option>`).join('')
    : '<option value="">ยังไม่มีหน่วยการเรียนรู้</option>'

  unitSelect.innerHTML = unitOptions
  topicUnitSelect.innerHTML = unitOptions
  unitSelect.disabled = units.length === 0
  topicUnitSelect.disabled = units.length === 0

  if (units.some(unit => unit.id === currentLessonUnit)) unitSelect.value = currentLessonUnit
  if (units.some(unit => unit.id === currentTopicUnit)) topicUnitSelect.value = currentTopicUnit
  renderLessonTopicOptions(preferredSelections.lessonTopicId)
}

function renderLessonTopicOptions(preferredTopicId = '') {
  const topicSelect = document.getElementById('topicSelect')
  const unitId = document.getElementById('unitSelect').value
  const currentTopic = preferredTopicId || topicSelect.value
  const matchingTopics = topics.filter(topic => topic.unit_id === unitId)
  topicSelect.innerHTML = matchingTopics.length
    ? matchingTopics.map(topic => `<option value="${topic.id}">${escapeHtml(topic.title)} (ลำดับ ${topic.sort_order})</option>`).join('')
    : '<option value="">ยังไม่มีหัวข้อในหน่วยนี้</option>'
  topicSelect.disabled = matchingTopics.length === 0
  if (matchingTopics.some(topic => topic.id === currentTopic)) topicSelect.value = currentTopic
}

function groupLessons(items) {
  const units = []
  items.forEach(lesson => {
    const unitTitle = lesson.unit_title?.trim() || 'หน่วยการเรียนรู้ทั่วไป'
    const topicTitle = lesson.topic_title?.trim() || 'หัวข้อทั่วไป'
    let unit = units.find(item => item.title === unitTitle)
    if (!unit) {
      unit = { title: unitTitle, order: clampOrder(lesson.unit_order), topics: [] }
      units.push(unit)
    }
    let topic = unit.topics.find(item => item.title === topicTitle)
    if (!topic) {
      topic = { title: topicTitle, order: clampOrder(lesson.topic_order), lessons: [] }
      unit.topics.push(topic)
    }
    topic.lessons.push(lesson)
  })
  return units
}

function clampOrder(value) {
  return Math.min(9999, Math.max(0, Math.trunc(Number(value) || 0)))
}

function extractYouTubeId(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./, '')
    let id = ''
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || ''
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v') || ''
      else id = url.pathname.split('/').filter(Boolean)[1] || ''
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : ''
  } catch {
    return /^[A-Za-z0-9_-]{11}$/.test(value) ? value : ''
  }
}

function formatDuration(seconds) {
  const minutes = Math.ceil((Number(seconds) || 0) / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} ชม. ${minutes % 60} นาที` : `${minutes} นาที`
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character])
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast')
  toast.textContent = message
  toast.className = `toast show${isError ? ' error' : ''}`
  window.setTimeout(() => { toast.className = 'toast' }, 3000)
}

function redirectToLogin() { location.href = 'index.html' }
