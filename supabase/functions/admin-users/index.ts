import { createClient, type User } from 'npm:@supabase/supabase-js@2'

type ProfileRow = {
  id: string
  first_name: string | null
  last_name: string | null
  role: string | null
  grade: string | null
  no: number | null
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const allowedRoles = new Set(['student', 'teacher', 'community', 'admin'])

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY')
    if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase server configuration is missing')

    const authorization = request.headers.get('Authorization') || ''
    const accessToken = authorization.replace(/^Bearer\s+/i, '')
    if (!accessToken) return json({ ok: false, error: 'กรุณาเข้าสู่ระบบ' }, 401)

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: authData, error: authError } = await adminClient.auth.getUser(accessToken)
    if (authError || !authData.user) return json({ ok: false, error: 'เซสชันไม่ถูกต้องหรือหมดอายุ' }, 401)

    const callerId = authData.user.id
    const { data: callerProfile, error: profileError } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', callerId)
      .single()

    if (profileError || callerProfile?.role !== 'admin') {
      return json({ ok: false, error: 'บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ' }, 403)
    }

    const body = await request.json()
    const action = String(body?.action || '')

    if (action === 'list_users') {
      const authUsers: User[] = []
      for (let page = 1; page <= 20; page += 1) {
        const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 })
        if (error) throw error
        authUsers.push(...data.users)
        if (data.users.length < 1000) break
      }

      const { data: profiles, error: profilesError } = await adminClient
        .from('profiles')
        .select('id, first_name, last_name, role, grade, no')
      if (profilesError) throw profilesError

      const profileMap = new Map<string, ProfileRow>(((profiles || []) as ProfileRow[]).map((profile) => [profile.id, profile]))
      const users = authUsers.map((user) => {
        const profile = profileMap.get(user.id)
        return {
          id: user.id,
          email: user.email || '',
          created_at: user.created_at,
          last_sign_in_at: user.last_sign_in_at,
          email_confirmed_at: user.email_confirmed_at,
          first_name: profile?.first_name || '',
          last_name: profile?.last_name || '',
          role: profile?.role || 'community',
          grade: profile?.grade || null,
          no: profile?.no || null,
        }
      })

      return json({ ok: true, users })
    }

    if (action === 'delete_community_post') {
      const postId = String(body?.post_id ?? '').trim()
      if (!postId || postId.length > 128) return json({ ok: false, error: 'รหัสโพสต์ไม่ถูกต้อง' }, 400)

      const { data: post, error: postError } = await adminClient
        .from('community_posts')
        .select('id, image_url')
        .eq('id', postId)
        .maybeSingle()
      if (postError) throw postError
      if (!post) return json({ ok: false, error: 'ไม่พบโพสต์ที่ต้องการลบ' }, 404)

      const { data: deletedPosts, error: deleteError } = await adminClient
        .from('community_posts')
        .delete()
        .eq('id', post.id)
        .select('id')
      if (deleteError) throw deleteError
      if (deletedPosts?.length !== 1) throw new Error('โพสต์ไม่ถูกลบ กรุณาลองใหม่อีกครั้ง')

      let imageCleanupError = ''
      const imagePath = getStoragePath(post.image_url, 'pics')
      if (imagePath) {
        const { error: storageError } = await adminClient.storage.from('pics').remove([imagePath])
        if (storageError) imageCleanupError = storageError.message
      }

      return json({ ok: true, deleted_id: post.id, image_cleanup_error: imageCleanupError || null })
    }

    const userId = String(body?.user_id || '')
    if (!isUuid(userId)) return json({ ok: false, error: 'รหัสบัญชีไม่ถูกต้อง' }, 400)

    if (action === 'update_user') {
      const role = String(body?.role || '')
      const email = String(body?.email || '').trim().toLowerCase()
      const firstName = String(body?.first_name || '').trim()
      const lastName = String(body?.last_name || '').trim()
      if (!allowedRoles.has(role)) return json({ ok: false, error: 'บทบาทไม่ถูกต้อง' }, 400)
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) return json({ ok: false, error: 'อีเมลไม่ถูกต้อง' }, 400)
      if (!firstName || !lastName) return json({ ok: false, error: 'กรุณาระบุชื่อและนามสกุล' }, 400)
      if (userId === callerId && role !== 'admin') return json({ ok: false, error: 'ไม่สามารถลดสิทธิ์บัญชี Admin ที่กำลังใช้งาน' }, 400)

      const { data: previousProfile, error: previousProfileError } = await adminClient
        .from('profiles')
        .select('first_name, last_name, role')
        .eq('id', userId)
        .maybeSingle()
      if (previousProfileError) throw previousProfileError

      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(userId, { email })
      if (authUpdateError) throw authUpdateError

      const { error: profileUpdateError } = await adminClient.from('profiles').upsert({
        id: userId,
        first_name: firstName,
        last_name: lastName,
        role,
        grade: role === 'student' ? body.grade || null : null,
        no: role === 'student' && body.no ? Number(body.no) : null,
      }, { onConflict: 'id' })
      if (profileUpdateError) throw profileUpdateError

      const previousName = `${previousProfile?.first_name || ''} ${previousProfile?.last_name || ''}`.trim()
      const updatedName = `${firstName} ${lastName}`.trim()
      if (previousName && previousName !== updatedName && previousProfile?.role === 'teacher') {
        const { error: advisorUpdateError } = await adminClient
          .from('student_projects')
          .update({ advisor: updatedName })
          .eq('advisor', previousName)
        if (advisorUpdateError) throw advisorUpdateError
      }
      if (previousName !== updatedName) {
        const { error: ownerNameUpdateError } = await adminClient
          .from('student_projects')
          .update({ student_name: updatedName })
          .eq('student_id', userId)
        if (ownerNameUpdateError) throw ownerNameUpdateError
      }
      return json({ ok: true })
    }

    if (action === 'reset_password') {
      const password = String(body?.new_password || '')
      if (password.length < 8 || password.length > 72) return json({ ok: false, error: 'รหัสผ่านต้องมี 8–72 ตัวอักษร' }, 400)
      const { error } = await adminClient.auth.admin.updateUserById(userId, { password })
      if (error) throw error
      return json({ ok: true })
    }

    if (action === 'delete_user') {
      if (userId === callerId) return json({ ok: false, error: 'ไม่สามารถลบบัญชี Admin ที่กำลังใช้งาน' }, 400)

      const { data: targetProfile } = await adminClient.from('profiles').select('role').eq('id', userId).maybeSingle()
      if (targetProfile?.role === 'admin') {
        const { count } = await adminClient.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin')
        if ((count || 0) <= 1) return json({ ok: false, error: 'ไม่สามารถลบ Admin คนสุดท้ายของระบบ' }, 400)
      }

      if (targetProfile?.role === 'teacher') {
        const { data: teacherProfile } = await adminClient
          .from('profiles')
          .select('first_name, last_name')
          .eq('id', userId)
          .maybeSingle()
        const teacherName = `${teacherProfile?.first_name || ''} ${teacherProfile?.last_name || ''}`.trim()
        if (teacherName) {
          const { error: advisorClearError } = await adminClient
            .from('student_projects')
            .update({ advisor: null, status: 'pending' })
            .eq('advisor', teacherName)
          if (advisorClearError) throw advisorClearError
        }
      }

      const { data: ownedProjects, error: projectsError } = await adminClient
        .from('student_projects')
        .select('id')
        .eq('student_id', userId)
      if (projectsError) throw projectsError

      const projectIds = (ownedProjects || []).map((project) => project.id)
      if (projectIds.length) {
        const { error: ownedMembersError } = await adminClient.from('project_member').delete().in('project_id', projectIds)
        if (ownedMembersError) throw ownedMembersError
      }
      const { error: membershipsError } = await adminClient.from('project_member').delete().eq('student_id', userId)
      if (membershipsError) throw membershipsError
      const { error: ownedProjectsError } = await adminClient.from('student_projects').delete().eq('student_id', userId)
      if (ownedProjectsError) throw ownedProjectsError

      const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(userId, false)
      if (deleteAuthError) throw deleteAuthError
      await adminClient.from('profiles').delete().eq('id', userId)
      return json({ ok: true })
    }

    return json({ ok: false, error: 'ไม่รู้จักคำสั่ง Admin นี้' }, 400)
  } catch (error) {
    console.error(error)
    return json({ ok: false, error: error instanceof Error ? error.message : 'เกิดข้อผิดพลาดภายในระบบ' }, 500)
  }
})

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function getStoragePath(imageUrl: unknown, bucketName: string) {
  if (typeof imageUrl !== 'string' || !imageUrl) return ''
  try {
    const url = new URL(imageUrl)
    const marker = `/storage/v1/object/public/${bucketName}/`
    const markerIndex = url.pathname.indexOf(marker)
    return markerIndex === -1 ? '' : decodeURIComponent(url.pathname.slice(markerIndex + marker.length))
  } catch {
    return ''
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  })
}
