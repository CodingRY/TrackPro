const SUPABASE_URL = 'https://klszrjhdpvsiktddzpga.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtsc3pyamhkcHZzaWt0ZGR6cGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDMzODMsImV4cCI6MjA4NzA3OTM4M30.zcK4gseuAMxweSWEGWYSuUcPui0EJgOcE66XsKw6wUM'
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

let currentUser = null
let currentProfile = null
let selectedAvatar = null
let previewObjectUrl = ''
let removeAvatarRequested = false
let toastTimer = null

document.getElementById('profileForm').addEventListener('submit', saveProfile)
document.getElementById('avatarInput').addEventListener('change', selectAvatar)
document.getElementById('removeAvatar').addEventListener('click', removeAvatarPreview)
document.getElementById('firstName').addEventListener('input', updatePreviewName)
document.getElementById('lastName').addEventListener('input', updatePreviewName)
document.getElementById('bio').addEventListener('input', updateBioCount)

init()

async function init() {
  try {
    const { data: { user }, error: authError } = await sb.auth.getUser()
    if (authError || !user) {
      location.href = 'index.html'
      return
    }
    currentUser = user

    const { data: profile, error } = await sb
      .from('profiles')
      .select('first_name,last_name,role,grade,no,phone,bio,avatar_path')
      .eq('id', user.id)
      .single()

    if (error) throw error
    if (!['student', 'teacher'].includes(profile?.role)) {
      location.href = profile?.role === 'admin' ? 'admin.html' : 'index.html'
      return
    }

    currentProfile = profile
    fillForm(profile)
    document.getElementById('pageLoading').hidden = true
    document.getElementById('profilePage').hidden = false
  } catch (error) {
    console.error(error)
    document.getElementById('pageLoading').hidden = true
    document.getElementById('pageErrorText').textContent = readableError(error)
    document.getElementById('pageError').hidden = false
  }
}

function fillForm(profile) {
  const isStudent = profile.role === 'student'
  document.getElementById('firstName').value = profile.first_name || ''
  document.getElementById('lastName').value = profile.last_name || ''
  document.getElementById('email').value = currentUser.email || ''
  document.getElementById('phone').value = profile.phone || ''
  document.getElementById('grade').value = profile.grade || ''
  document.getElementById('studentNo').value = profile.no || ''
  document.getElementById('bio').value = profile.bio || ''
  document.getElementById('studentFields').hidden = !isStudent
  document.getElementById('grade').required = isStudent
  document.getElementById('studentNo').required = isStudent
  document.getElementById('roleBadge').textContent = isStudent ? 'บัญชีนักเรียน' : 'บัญชีครูที่ปรึกษา'
  document.getElementById('previewRole').textContent = isStudent ? 'นักเรียน' : 'ครูที่ปรึกษา'
  document.getElementById('removeAvatar').hidden = !profile.avatar_path
  updatePreviewName()
  updateBioCount()
  showStoredAvatar(profile.avatar_path)
}

function selectAvatar(event) {
  const file = event.target.files?.[0]
  if (!file) return
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
  if (!allowedTypes.includes(file.type)) {
    event.target.value = ''
    return showToast('รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP', true)
  }
  if (file.size > 5 * 1024 * 1024) {
    event.target.value = ''
    return showToast('รูปภาพต้องมีขนาดไม่เกิน 5 MB', true)
  }

  selectedAvatar = file
  removeAvatarRequested = false
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl)
  previewObjectUrl = URL.createObjectURL(file)
  showAvatarImage(previewObjectUrl)
  document.getElementById('removeAvatar').hidden = false
}

function removeAvatarPreview() {
  selectedAvatar = null
  removeAvatarRequested = true
  document.getElementById('avatarInput').value = ''
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl)
  previewObjectUrl = ''
  showAvatarFallback()
  document.getElementById('removeAvatar').hidden = true
}

async function saveProfile(event) {
  event.preventDefault()
  const button = document.getElementById('saveButton')
  const firstName = document.getElementById('firstName').value.trim()
  const lastName = document.getElementById('lastName').value.trim()
  const isStudent = currentProfile.role === 'student'
  const oldAvatarPath = currentProfile.avatar_path || null
  let avatarPath = removeAvatarRequested ? null : oldAvatarPath
  let uploadedPath = null

  if (!firstName || !lastName) return showToast('กรุณากรอกชื่อและนามสกุล', true)
  setButtonBusy(button, true)

  try {
    if (selectedAvatar) {
      const extension = fileExtension(selectedAvatar)
      uploadedPath = `${currentUser.id}/avatar-${Date.now()}.${extension}`
      const { error: uploadError } = await sb.storage
        .from('avatars')
        .upload(uploadedPath, selectedAvatar, { contentType: selectedAvatar.type, upsert: false })
      if (uploadError) throw uploadError
      avatarPath = uploadedPath
    }

    const { data, error } = await sb.rpc('update_own_profile', {
      p_first_name: firstName,
      p_last_name: lastName,
      p_grade: isStudent ? document.getElementById('grade').value.trim() : null,
      p_no: isStudent ? Number(document.getElementById('studentNo').value) : null,
      p_phone: document.getElementById('phone').value.trim(),
      p_bio: document.getElementById('bio').value.trim(),
      p_avatar_path: avatarPath
    })
    if (error) throw error

    if (oldAvatarPath && oldAvatarPath !== avatarPath) {
      const { error: removeError } = await sb.storage.from('avatars').remove([oldAvatarPath])
      if (removeError) console.error(removeError)
    }

    currentProfile = { ...currentProfile, ...(data || {}), avatar_path: avatarPath }
    selectedAvatar = null
    removeAvatarRequested = false
    document.getElementById('avatarInput').value = ''
    document.getElementById('removeAvatar').hidden = !avatarPath
    showStoredAvatar(avatarPath)
    showToast('บันทึกข้อมูลส่วนตัวเรียบร้อยแล้ว')
  } catch (error) {
    console.error(error)
    if (uploadedPath) await sb.storage.from('avatars').remove([uploadedPath])
    showToast(readableError(error), true)
  } finally {
    setButtonBusy(button, false)
  }
}

function showStoredAvatar(path) {
  if (!path) return showAvatarFallback()
  const { data } = sb.storage.from('avatars').getPublicUrl(path)
  showAvatarImage(`${data.publicUrl}?v=${Date.now()}`)
}

function showAvatarImage(url) {
  const image = document.getElementById('avatarImage')
  image.src = url
  image.hidden = false
  document.getElementById('avatarFallback').hidden = true
  image.onerror = showAvatarFallback
}

function showAvatarFallback() {
  const image = document.getElementById('avatarImage')
  image.hidden = true
  image.removeAttribute('src')
  const fallback = document.getElementById('avatarFallback')
  fallback.textContent = (document.getElementById('firstName').value.trim() || 'ผ').charAt(0).toUpperCase()
  fallback.hidden = false
}

function updatePreviewName() {
  const fullName = `${document.getElementById('firstName').value.trim()} ${document.getElementById('lastName').value.trim()}`.trim() || 'ผู้ใช้งาน'
  document.getElementById('previewName').textContent = fullName
  if (document.getElementById('avatarImage').hidden) showAvatarFallback()
}

function updateBioCount() {
  document.getElementById('bioCount').textContent = document.getElementById('bio').value.length
}

function fileExtension(file) {
  const byType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
  return byType[file.type] || 'jpg'
}

function setButtonBusy(button, busy) {
  button.disabled = busy
  button.textContent = busy ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast')
  toast.textContent = message
  toast.className = `toast show${isError ? ' error' : ''}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.className = 'toast' }, 3200)
}

function readableError(error) {
  const message = String(error?.message || 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
  const replacements = [
    ['Only teachers and students can edit this profile', 'หน้านี้สำหรับบัญชีครูและนักเรียนเท่านั้น'],
    ['First name and last name are required', 'กรุณากรอกชื่อและนามสกุล'],
    ['Student grade and number are required', 'กรุณากรอกชั้นและเลขที่ให้ถูกต้อง'],
    ['Phone number is too long', 'เบอร์โทรศัพท์ยาวเกินกำหนด'],
    ['Bio is too long', 'ข้อความแนะนำตัวยาวเกิน 500 ตัวอักษร'],
    ['Invalid avatar path', 'ตำแหน่งรูปประจำตัวไม่ถูกต้อง'],
    ['Bucket not found', 'ยังไม่ได้ตั้งค่าพื้นที่จัดเก็บรูปประจำตัว']
  ]
  return replacements.find(([source]) => message.includes(source))?.[1] || message
}
