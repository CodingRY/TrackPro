const SUPABASE_URL = 'https://klszrjhdpvsiktddzpga.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtsc3pyamhkcHZzaWt0ZGR6cGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDMzODMsImV4cCI6MjA4NzA3OTM4M30.zcK4gseuAMxweSWEGWYSuUcPui0EJgOcE66XsKw6wUM'
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

let lessons = []
let progressByLesson = new Map()
let activeLesson = null
let player = null
let playerReady = false
let isPlaying = false
let lastPlayerTime = 0
let pendingWatchSeconds = 0
let saveInFlight = false
let youtubeApiReady = false
let timerId = null

init()

async function init() {
  try {
    if (location.protocol === 'file:') {
      showPageError('กรุณาเปิด TrackPro ผ่าน http://127.0.0.1:5500 เพื่อให้ YouTube เล่นและบันทึกเวลาได้')
      return
    }

    const { data: { user }, error: authError } = await sb.auth.getUser()
    if (authError || !user) return redirectToLogin()

    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('first_name,last_name,role')
      .eq('id', user.id)
      .single()

    if (profileError || profile?.role !== 'student') {
      alert('หน้านี้สำหรับบัญชีนักเรียนเท่านั้น')
      location.href = profile?.role === 'admin' ? 'admin.html' : 'dashboard.html'
      return
    }

    const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'นักเรียน'
    document.getElementById('accountName').textContent = fullName
    document.getElementById('accountAvatar').textContent = fullName.charAt(0).toUpperCase()

    const [lessonResult, progressResult] = await Promise.all([
      sb.from('learning_lessons').select('*').eq('is_published', true)
        .order('unit_order').order('unit_title')
        .order('topic_order').order('topic_title')
        .order('sort_order').order('created_at'),
      sb.from('learning_progress').select('*').eq('student_id', user.id)
    ])

    if (lessonResult.error) throw lessonResult.error
    if (progressResult.error) throw progressResult.error

    lessons = lessonResult.data || []
    ;(progressResult.data || []).forEach(item => progressByLesson.set(item.lesson_id, item))

    document.getElementById('pageLoading').hidden = true
    if (!lessons.length) {
      document.getElementById('courseEmpty').hidden = false
      return
    }

    document.getElementById('courseContent').hidden = false
    renderCourse()
    await selectLesson(lessons[0].id)
    loadYouTubeApi()
    timerId = window.setInterval(trackPlayback, 5000)
  } catch (error) {
    console.error(error)
    showPageError(error.message || 'กรุณาลองใหม่อีกครั้ง')
  }
}

function loadYouTubeApi() {
  if (window.YT?.Player) {
    youtubeApiReady = true
    createOrLoadPlayer()
    return
  }
  const script = document.createElement('script')
  script.src = 'https://www.youtube.com/iframe_api'
  script.referrerPolicy = 'strict-origin-when-cross-origin'
  document.head.appendChild(script)
}

window.onYouTubeIframeAPIReady = function () {
  youtubeApiReady = true
  createOrLoadPlayer()
}

async function selectLesson(lessonId) {
  if (activeLesson?.id === lessonId) return
  collectPlaybackDelta()
  await persistProgress()

  activeLesson = lessons.find(item => item.id === lessonId)
  if (!activeLesson) return

  isPlaying = false
  lastPlayerTime = 0
  document.getElementById('currentLessonTitle').textContent = activeLesson.title
  document.getElementById('currentLessonDescription').textContent = activeLesson.description || 'บทเรียนวิดีโอสำหรับพัฒนาทักษะและโครงงาน'
  document.getElementById('watchStatusText').textContent = 'กดเล่นวิดีโอเพื่อเริ่มสะสมเวลา'
  renderCourse()
  createOrLoadPlayer()
}

function createOrLoadPlayer() {
  if (!youtubeApiReady || !activeLesson) return
  const savedPosition = Math.max(0, Number(progressByLesson.get(activeLesson.id)?.last_position_seconds) || 0)
  document.getElementById('playerPlaceholder').hidden = true

  if (!player) {
    player = new YT.Player('youtubePlayer', {
      videoId: activeLesson.youtube_video_id,
      playerVars: {
        autoplay: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        start: Math.floor(savedPosition),
        origin: window.location.origin
      },
      events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange, onError: onPlayerError }
    })
    return
  }

  playerReady = true
  player.loadVideoById({ videoId: activeLesson.youtube_video_id, startSeconds: Math.floor(savedPosition) })
}

function onPlayerReady(event) {
  playerReady = true
  const savedPosition = Number(progressByLesson.get(activeLesson?.id)?.last_position_seconds) || 0
  if (savedPosition > 0) event.target.seekTo(savedPosition, true)
  event.target.mute()
  event.target.playVideo()
  document.getElementById('watchStatusText').textContent = 'กำลังเล่นอัตโนมัติ • กดเปิดเสียงได้จากตัวเล่น'
}

function onPlayerStateChange(event) {
  collectPlaybackDelta()
  isPlaying = event.data === YT.PlayerState.PLAYING
  lastPlayerTime = safePlayerTime()

  if (isPlaying) {
    document.getElementById('watchStatusText').textContent = 'กำลังสะสมเวลาเรียน...'
  } else if (event.data === YT.PlayerState.ENDED) {
    document.getElementById('watchStatusText').textContent = 'ดูวิดีโอจบแล้ว กำลังบันทึกความคืบหน้า'
    persistProgress()
  } else {
    document.getElementById('watchStatusText').textContent = 'หยุดชั่วคราว • เวลาที่เรียนถูกบันทึกแล้ว'
    persistProgress()
  }
}

function onPlayerError(event) {
  const errorCode = Number(event?.data)
  console.error('YouTube player error:', errorCode)
  document.getElementById('watchStatusText').textContent = errorCode === 153
    ? 'YouTube ไม่พบข้อมูลเว็บไซต์ กรุณาเปิดผ่าน http://127.0.0.1:5500 แล้วโหลดหน้าใหม่'
    : 'ไม่สามารถเล่นวิดีโอนี้ได้ กรุณาแจ้งผู้ดูแลระบบ'
}

function trackPlayback() {
  collectPlaybackDelta()
  if (pendingWatchSeconds >= 1) persistProgress()
}

function collectPlaybackDelta() {
  if (!playerReady || !player || !activeLesson) return
  const currentTime = safePlayerTime()

  if (isPlaying && !document.hidden) {
    const delta = currentTime - lastPlayerTime
    if (delta > 0 && delta <= 7) pendingWatchSeconds += delta
  }
  lastPlayerTime = currentTime
}

async function persistProgress() {
  while (saveInFlight) await new Promise(resolve => window.setTimeout(resolve, 50))
  if (!activeLesson || !playerReady) return
  const delta = Math.min(10, Math.floor(pendingWatchSeconds))
  if (delta < 1) return

  pendingWatchSeconds -= delta
  saveInFlight = true
  const lessonAtSave = activeLesson
  const watchedBeforeSave = Number(progressByLesson.get(lessonAtSave.id)?.watched_seconds) || 0
  const position = Math.round(safePlayerTime())

  try {
    const { data, error } = await sb.rpc('record_learning_progress', {
      p_lesson_id: lessonAtSave.id,
      p_delta_seconds: delta,
      p_position_seconds: position
    })
    if (error) throw error
    const savedProgress = Array.isArray(data) ? data[0] : data
    if (savedProgress) {
      progressByLesson.set(lessonAtSave.id, savedProgress)
      const credited = Math.max(0, Number(savedProgress.watched_seconds) - watchedBeforeSave)
      if (Number(savedProgress.watched_seconds) < lessonAtSave.duration_seconds) {
        pendingWatchSeconds += Math.max(0, delta - credited)
      }
    }
    renderCourse()
  } catch (error) {
    console.error(error)
    pendingWatchSeconds += delta
    showToast('บันทึกเวลาเรียนไม่สำเร็จ ระบบจะลองใหม่อัตโนมัติ', true)
  } finally {
    saveInFlight = false
  }
}

function renderCourse() {
  const totalRequired = lessons.reduce((sum, lesson) => sum + lesson.duration_seconds, 0)
  const totalWatched = lessons.reduce((sum, lesson) => {
    const watched = Number(progressByLesson.get(lesson.id)?.watched_seconds) || 0
    return sum + Math.min(watched, lesson.duration_seconds)
  }, 0)
  const completed = lessons.filter(lesson => progressByLesson.get(lesson.id)?.completed).length
  const overall = totalRequired ? Math.min(100, Math.round(totalWatched / totalRequired * 100)) : 0

  document.getElementById('completionLabel').textContent = `สำเร็จ ${completed}/${lessons.length} บท`
  document.getElementById('overallPercent').textContent = `${overall}%`
  document.getElementById('overallProgress').style.width = `${overall}%`
  document.getElementById('totalWatchTime').textContent = formatDuration(totalWatched)
  document.getElementById('lessonCount').textContent = lessons.length

  if (activeLesson) {
    const watched = Number(progressByLesson.get(activeLesson.id)?.watched_seconds) || 0
    const percent = Math.min(100, Math.round(watched / activeLesson.duration_seconds * 100))
    document.getElementById('currentLessonProgress').textContent = `${percent}%`
  }

  const lessonNumbers = new Map(lessons.map((lesson, index) => [lesson.id, index + 1]))
  document.getElementById('lessonList').innerHTML = groupLessons(lessons).map(unit => `
    <section class="lesson-unit-group">
      <header class="lesson-unit-heading">
        <span>หน่วยการเรียนรู้</span>
        <strong>${escapeHtml(unit.title)}</strong>
      </header>
      ${unit.topics.map(topic => `
        <div class="lesson-topic-group">
          <div class="lesson-topic-heading">${escapeHtml(topic.title)}</div>
          ${topic.lessons.map(lesson => {
            const progress = progressByLesson.get(lesson.id)
            const percent = Math.min(100, Math.round((Number(progress?.watched_seconds) || 0) / lesson.duration_seconds * 100))
            const isComplete = Boolean(progress?.completed)
            return `
              <button class="lesson-item ${lesson.id === activeLesson?.id ? 'active' : ''} ${isComplete ? 'completed' : ''}" type="button" data-lesson-id="${lesson.id}">
                <span class="lesson-state">${isComplete ? '✓' : lessonNumbers.get(lesson.id)}</span>
                <span class="lesson-copy"><strong>${escapeHtml(lesson.title)}</strong><small>${percent}% ของบทเรียน</small></span>
                <span class="lesson-duration">${formatDuration(lesson.duration_seconds)}</span>
              </button>`
          }).join('')}
        </div>`).join('')}
    </section>`).join('')

  document.querySelectorAll('[data-lesson-id]').forEach(button => {
    button.addEventListener('click', () => selectLesson(button.dataset.lessonId))
  })
}

function groupLessons(items) {
  const units = []
  items.forEach(lesson => {
    const unitTitle = lesson.unit_title?.trim() || 'หน่วยการเรียนรู้ทั่วไป'
    const topicTitle = lesson.topic_title?.trim() || 'หัวข้อทั่วไป'
    let unit = units.find(item => item.title === unitTitle)
    if (!unit) {
      unit = { title: unitTitle, topics: [] }
      units.push(unit)
    }
    let topic = unit.topics.find(item => item.title === topicTitle)
    if (!topic) {
      topic = { title: topicTitle, lessons: [] }
      unit.topics.push(topic)
    }
    topic.lessons.push(lesson)
  })
  return units
}

function safePlayerTime() {
  try { return Number(player?.getCurrentTime?.()) || 0 } catch { return 0 }
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

function showToast(message, isError = false) {
  const toast = document.getElementById('toast')
  toast.textContent = message
  toast.className = `toast show${isError ? ' error' : ''}`
  window.setTimeout(() => { toast.className = 'toast' }, 3000)
}

function showPageError(message) {
  document.getElementById('pageLoading').hidden = true
  document.getElementById('courseContent').hidden = true
  document.getElementById('pageErrorText').textContent = message
  document.getElementById('pageError').hidden = false
}

function redirectToLogin() {
  location.href = 'index.html'
}

document.addEventListener('visibilitychange', () => {
  collectPlaybackDelta()
  if (document.hidden) persistProgress()
})

window.addEventListener('pagehide', () => {
  collectPlaybackDelta()
  persistProgress()
  if (timerId) window.clearInterval(timerId)
})
