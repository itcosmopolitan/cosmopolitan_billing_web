import { useState, useEffect, useMemo } from 'react'
import toast from 'react-hot-toast'
import { roleColors } from '@/utils/helpers'
import { usersAPI, branchesAPI, rolesAPI, permissionsAPI, settingsAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { SectionHeader, Card, Tabs, Chip, Modal, FormGroup, FormRow, Tag, AlertBar, Avatar, PaginationBar, SortableHeader, SegmentedToggle, MultiSelect, TruncatedChipList } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'
import RoleEditor from './RoleEditor'
import { TaxConfigTab, NumberingTab, InvoiceTemplateTab } from './SettingsTabs'

const EMPTY_ORG_FORM = {
  id: '',
  name: '',
  gstin: '',
  pan: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  state_code: '33',
  financial_year: 'Apr-Mar',
}

const TABS = [
  { id: 'org',      label: '🏢 Organisation' },
  { id: 'branches', label: '🏪 Branches' },
  { id: 'users',    label: '👥 Users & Roles' },
  { id: 'tax',      label: '🧾 Tax Config' },
  { id: 'numbering',label: '🔢 Document Numbering' },
  { id: 'invoice',  label: '🖨 Invoice Template' },
]


export default function SettingsPage() {
  const can = useCan()
  const [tab, setTab]         = useState('org')
  // Sub-toggle inside the "Users & Roles" parent tab — picks between the
  // Users table view and the Roles cards view. Both render full-width
  // (replaces the previous 65/35 split). State is per-mount, so toggling
  // away always returns to a fresh page-1 view (deliberate — preserve was
  // explicitly out of scope, see WORKSHEET 2026-05-18).
  const [usersTab, setUsersTab] = useState('users')
  const [showUser, setShowUser] = useState(false)
  const [users, setUsers]     = useState([])
  const [userTotal, setUserTotal] = useState(0)
  const [userSkip, setUserSkip] = useState(0)
  const [userLimit, setUserLimit] = useState(DEFAULT_PAGE_SIZE)
  const [userSortBy, setUserSortBy] = useState('name')
  const [userSortOrder, setUserSortOrder] = useState('asc')
  const [userListVersion, setUserListVersion] = useState(0)
  // Roles are loaded when the Roles sub-tab is opened (small list — the
  // catalog of role types, typically <20). Paginate client-side for
  // consistency with the Users table.
  const [roleSkip, setRoleSkip] = useState(0)
  const [roleLimit, setRoleLimit] = useState(DEFAULT_PAGE_SIZE)
  const [branches, setBranches] = useState([])
  const [brSkip, setBrSkip] = useState(0)
  const [brLimit, setBrLimit] = useState(DEFAULT_PAGE_SIZE)
  // Branches tab state — fetched when that tab is active. User modals use
  // storeBranches (hydrated at app boot) for branch pickers.
  const [branchSortBy, setBranchSortBy] = useState('name')
  const [branchSortOrder, setBranchSortOrder] = useState('asc')
  const [showBranch, setShowBranch] = useState(false)
  // Auto-generated temp password — admin can override. Re-rolled by the
  // useEffect below whenever the Add User modal opens, so two consecutive
  // creates don't share a password if the admin happens to forget to copy.
  // `branch_ids` is the multi-branch list — admin must pick ≥1 branch.
  // The legacy "all_branches" implicit-all mode was removed from the UI on
  // 2026-05-18 sixth session (see WORKSHEET); the backend still accepts
  // all_branches=True for older clients but nothing in this UI sends it.
  const [userForm, setUserForm] = useState({ name:'', email:'', role_id:'', branch_ids:[], active:true, password:'' })
  // After a successful create, holds the temp password to display in a
  // confirmation modal (with copy). Cleared on close. null while the modal
  // isn't open.
  const [createdUser, setCreatedUser] = useState(null)
  const [branchForm, setBranchForm] = useState({ name:'', code:'', manager:'', phone:'', address:'' })
  // Only the setter is consumed; loading state is used by tab fetchers.
  // eslint-disable-next-line no-unused-vars
  const [loading, setLoading] = useState(true)
  const puf = (k,v) => setUserForm(f=>({...f,[k]:v}))
  const pbf = (k,v) => setBranchForm(f=>({...f,[k]:v}))
  const [showEditBranch, setShowEditBranch] = useState(false)
  const [editBranchForm, setEditBranchForm] = useState({})
  const [showEditUser, setShowEditUser] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [editUserForm, setEditUserForm] = useState({ name:'', email:'', role_id:'', branch_ids:[] })
  const peuf = (k,v) => setEditUserForm(f=>({...f,[k]:v}))

  // RBAC: roles + permission catalog (Phase 1 of Users & Roles)
  const storeBranches = useAppStore((s) => s.branches)
  const setStoreBranches = useAppStore((s) => s.setBranches)
  const roles = useAppStore((s) => s.roles)
  const permCatalog = useAppStore((s) => s.permCatalog)
  const setRoles = useAppStore((s) => s.setRoles)
  const setPermCatalog = useAppStore((s) => s.setPermCatalog)
  const [editingRole, setEditingRole] = useState(null)   // role row or null for new
  const [showRoleEditor, setShowRoleEditor] = useState(false)
  const roleById = (id) => roles.find((r) => r.id === id)
  const roleForUser = (u) => roleById(u.role_id) || roles.find((r) => r.key === u.role)

  const loadAllBranches = async () => {
    try {
      const data = await fetchAllList(branchesAPI.list).catch(() => [])
      setBranches(data || [])
      setStoreBranches(data || [])
      return data || []
    } catch (err) {
      console.error(err)
      toast.error('Failed to load branches')
      return []
    }
  }

  const reloadRoles = async () => {
    try { setRoles(await rolesAPI.list()) } catch (e) { console.error(e) }
  }

  const loadPermCatalog = async () => {
    if (Object.keys(permCatalog).length > 0) return
    try {
      setPermCatalog(await permissionsAPI.catalog().catch(() => ({})))
    } catch (e) { console.error(e) }
  }

  const openNewRole = () => { setEditingRole(null); setShowRoleEditor(true) }
  const openEditRole = (role) => { setEditingRole(role); setShowRoleEditor(true) }
  const deleteRole = async (role) => {
    if (role.is_system) { toast.error('System roles cannot be deleted'); return }
    if (role.user_count > 0) { toast.error(`Reassign the ${role.user_count} user(s) using this role first`); return }
    if (!window.confirm(`Delete role "${role.label}"? This cannot be undone.`)) return
    try { await rolesAPI.delete(role.id); toast.success('Role deleted'); await reloadRoles() }
    catch (e) { console.error(e) }
  }

  // Branches tab — fetch only when that tab is active (default tab is org, no API).
  useEffect(() => {
    if (tab !== 'branches') return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const data = await fetchAllList(branchesAPI.list).catch(() => [])
        if (!cancelled) setBranches(data || [])
      } catch (err) {
        console.error(err)
        if (!cancelled) toast.error('Failed to load branches')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab])

  // Users sub-tab — fetch list when active (mirrors roles sub-tab below).
  useEffect(() => {
    if (tab !== 'users' || usersTab !== 'users') return
    let cancelled = false
    ;(async () => {
      try {
        const raw = await usersAPI.list({
          skip: userSkip,
          limit: userLimit,
          sort_by: userSortBy,
          sort_order: userSortOrder,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setUsers(items || [])
          setUserTotal(total)
        }
      } catch (err) {
        console.error(err)
        if (!cancelled) {
          setUsers([])
          setUserTotal(0)
        }
      }
    })()
    return () => { cancelled = true }
  }, [tab, usersTab, userSkip, userLimit, userListVersion, userSortBy, userSortOrder])

  // Roles sub-tab — roles + permission catalog (for RoleEditor) on demand.
  useEffect(() => {
    if (tab !== 'users' || usersTab !== 'roles') return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const [rolesData] = await Promise.all([
          rolesAPI.list().catch(() => []),
          loadPermCatalog(),
        ])
        if (!cancelled) setRoles(rolesData || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, usersTab])

  // Add/Edit User modals need the roles dropdown without visiting the Roles sub-tab.
  useEffect(() => {
    if (!showUser && !showEditUser) return
    if (roles.length > 0) return
    reloadRoles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showUser, showEditUser, roles.length])

  const onUserSort = (key) => {
    setUserSkip(0)
    if (userSortBy === key) {
      setUserSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setUserSortBy(key)
    setUserSortOrder('asc')
  }

  const sortedBranches = useMemo(() => {
    const dir = branchSortOrder === 'desc' ? -1 : 1
    const valueOf = (b) => b[branchSortBy] ?? ''
    return [...branches].sort((a, b) => {
      const av = valueOf(a)
      const bv = valueOf(b)
      if (typeof av === 'boolean' || typeof bv === 'boolean') {
        return ((av === true) - (bv === true)) * dir
      }
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [branches, branchSortBy, branchSortOrder])

  const branchPageRows = useMemo(
    () => sortedBranches.slice(brSkip, brSkip + brLimit),
    [sortedBranches, brSkip, brLimit]
  )

  const onBranchSort = (key) => {
    setBrSkip(0)
    if (branchSortBy === key) {
      setBranchSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setBranchSortBy(key)
    setBranchSortOrder('asc')
  }

  const pbfEdit = (k, v) => {
    setEditBranchForm(prev => ({ ...prev, [k]: v }))
  }

  const [orgForm, setOrgForm] = useState(EMPTY_ORG_FORM)
  const [orgSaving, setOrgSaving] = useState(false)
  const pof = (k,v) => setOrgForm(f=>({...f,[k]:v}))

  // Organisation tab — load profile from DB when active (default tab).
  useEffect(() => {
    if (tab !== 'org') return
    const controller = new AbortController()
    ;(async () => {
      try {
        setLoading(true)
        const data = await settingsAPI.getOrganisation({ signal: controller.signal })
        if (data) {
          setOrgForm({
            id: data.id || '',
            name: data.name || '',
            gstin: data.gstin || '',
            pan: data.pan || '',
            address: data.address || '',
            phone: data.phone || '',
            email: data.email || '',
            website: data.website || '',
            state_code: data.state_code || '33',
            financial_year: data.financial_year || 'Apr-Mar',
          })
        }
      } catch (err) {
        if (err?.code === 'ERR_CANCELED') return
        console.error(err)
        toast.error('Failed to load organisation profile')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [tab])

  const saveOrg = async () => {
    if (!orgForm.name?.trim()) {
      toast.error('Company name is required')
      return
    }
    setOrgSaving(true)
    try {
      const saved = await settingsAPI.updateOrganisation({
        name: orgForm.name.trim(),
        gstin: orgForm.gstin?.trim() || '',
        pan: orgForm.pan?.trim() || '',
        address: orgForm.address?.trim() || '',
        phone: orgForm.phone?.trim() || '',
        email: orgForm.email?.trim() || '',
        website: orgForm.website?.trim() || '',
        state_code: orgForm.state_code?.trim() || '33',
        financial_year: orgForm.financial_year || 'Apr-Mar',
      })
      setOrgForm((prev) => ({
        ...prev,
        id: saved?.id || prev.id,
        name: saved?.name ?? prev.name,
        gstin: saved?.gstin ?? prev.gstin,
        pan: saved?.pan ?? prev.pan,
        address: saved?.address ?? prev.address,
        phone: saved?.phone ?? prev.phone,
        email: saved?.email ?? prev.email,
        website: saved?.website ?? prev.website,
        state_code: saved?.state_code ?? prev.state_code,
        financial_year: saved?.financial_year ?? prev.financial_year,
      }))
      toast.success('Organisation profile saved')
    } catch (err) {
      console.error(err)
      // Toast already fired by global axios interceptor on non-2xx
    } finally {
      setOrgSaving(false)
    }
  }

  // Cryptographically random URL-safe temp password generator. ~12 chars
  // from 9 random bytes. Matches the server-side default in
  // backend/src/routes/users.py (_generate_temp_password) so the admin sees
  // a similar shape whether they take the pre-fill or let the server gen.
  const generateTempPassword = () => {
    const bytes = new Uint8Array(9)
    window.crypto.getRandomValues(bytes)
    // base64url: + → -, / → _, strip padding
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  // Whenever the Add User modal opens, roll a fresh password into the form.
  // The admin sees it pre-filled (transparency) and can clear or edit it.
  useEffect(() => {
    if (showUser) {
      setUserForm((f) => ({ ...f, password: generateTempPassword() }))
    }
  }, [showUser])

  // Loose RFC-5322-inspired check — anything with a local part, an @, a
  // domain, and a TLD. Intentionally permissive (e.g. accepts `.local` TLDs
  // and most "weird but valid" addresses) so we don't reject things the
  // user typed correctly. The backend uses Pydantic EmailStr (stricter,
  // does deliverability checks) as the authoritative gate; this client-side
  // check just saves a round trip for the obvious typos.
  const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim())

  const saveUser = async () => {
    if (!userForm.name || !userForm.email) { toast.error('Name and email required'); return }
    if (!isValidEmail(userForm.email)) { toast.error('Enter a valid email (e.g. name@example.com)'); return }
    if (!userForm.role_id) { toast.error('Select a role'); return }
    // Mirror backend _assign_branches: caller must pick at least one branch.
    if (!userForm.branch_ids || userForm.branch_ids.length === 0) {
      toast.error('Pick at least one branch')
      return
    }
    // Backend would also accept an empty/missing password and auto-generate,
    // but for the post-create confirmation modal we always want a value to
    // display — so guard here too.
    if (!userForm.password || userForm.password.length < 8) {
      toast.error('Temporary password must be at least 8 characters')
      return
    }

    try {
      const payload = {
        name: userForm.name.trim(),
        // Normalise the same way auth.py reads the login email
        // (`data.email.lower()`) so a user created here matches their own
        // /auth/login lookup. Avoids "I created Foo@X.com, login fails"
        // class of bugs.
        email: userForm.email.trim().toLowerCase(),
        role_id: userForm.role_id,
        branch_ids: userForm.branch_ids,
        password: userForm.password,
      }
      const result = await usersAPI.create(payload)
      setUserSkip(0)
      setUserListVersion((v) => v + 1)
      setShowUser(false)
      // Show the post-create confirmation modal with the temp password to
      // share. Prefer the server-echoed `temp_password` (covers the case
      // where the server generated one because the admin cleared the
      // field) and fall back to what we sent.
      setCreatedUser({
        name: userForm.name,
        email: userForm.email,
        password: result?.temp_password || userForm.password,
      })
      setUserForm({ name:'', email:'', role_id:'', branch_ids:[], active:true, password:'' })
    } catch (err) {
      console.error(err)
      // toast already fired by global axios interceptor on non-2xx
    }
  }

  const copyTempPassword = async () => {
    if (!createdUser?.password) return
    try {
      await navigator.clipboard.writeText(createdUser.password)
      toast.success('Temporary password copied')
    } catch {
      toast.error('Copy failed — select and copy manually')
    }
  }

  const toggleUser = async (userId) => {
    try {
      await usersAPI.toggle(userId)
      setUserListVersion((v) => v + 1)
      toast.success('User status updated')
    } catch (err) {
      console.error(err)
      toast.error('Failed to update user')
    }
  }

  const openEditUser = (user) => {
    setEditingUser(user)
    // Source of truth: the multi-branch list. Fallbacks for legacy data:
    //   - Pre-multi-branch records (single user.branch_id, no list) → wrap
    //     the single id in an array.
    //   - Legacy all_branches=True records (e.g. a seeded super-admin from
    //     before the implicit-all UI was removed) → expand to every CURRENT
    //     branch. The first save then writes back an explicit list and the
    //     all_branches flag flips off, so the user is migrated in place.
    let initialBranchIds = []
    if (Array.isArray(user.branch_ids) && user.branch_ids.length > 0) {
      initialBranchIds = [...user.branch_ids]
    } else if (user.all_branches) {
      initialBranchIds = storeBranches.map((b) => b.id)
    } else if (user.branch_id) {
      initialBranchIds = [user.branch_id]
    }
    setEditUserForm({
      name: user.name,
      email: user.email,
      role_id: user.role_id || roleForUser(user)?.id || '',
      branch_ids: initialBranchIds,
    })
    setShowEditUser(true)
  }

  const saveEditUser = async () => {
    if (!editUserForm.name || !editUserForm.email) { toast.error('Name and email required'); return }
    if (!isValidEmail(editUserForm.email)) { toast.error('Enter a valid email (e.g. name@example.com)'); return }
    if (!editUserForm.role_id) { toast.error('Select a role'); return }
    if (!editUserForm.branch_ids || editUserForm.branch_ids.length === 0) {
      toast.error('Pick at least one branch')
      return
    }

    try {
      const payload = {
        name: editUserForm.name.trim(),
        email: editUserForm.email.trim().toLowerCase(),
        role_id: editUserForm.role_id,
        branch_ids: editUserForm.branch_ids,
      }
      await usersAPI.update(editingUser.id, payload)
      setUserListVersion((v) => v + 1)
      toast.success('User updated successfully')
      setShowEditUser(false)
      setEditingUser(null)
    } catch (err) {
      console.error(err)
      // toast already fired by global axios interceptor on non-2xx
    }
  }

  const saveBranch = async () => {
    try {
      await branchesAPI.create({
        name: branchForm.name,
        code: branchForm.code,
        manager: branchForm.manager,
        phone: branchForm.phone,
        address: branchForm.address,
        gstin: '',
        active: true,
      })
      setShowBranch(false)
      loadAllBranches()
      toast.success('Branch added')
    } catch (err) {
      console.error(err)
      // Toast already fired by global axios interceptor.
    }
  }

  const updateBranch = async () => {
    try {
      await branchesAPI.update(editBranchForm.id, {
        name: editBranchForm.name,
        code: editBranchForm.code,
        manager: editBranchForm.manager,
        phone: editBranchForm.phone,
        address: editBranchForm.address,
        gstin: editBranchForm.gstin || '',
        active: editBranchForm.active ?? true,
      })
      toast.success('Branch updated')
      setShowEditBranch(false)
      loadAllBranches()
    } catch (err) {
      console.error(err)
      // Toast already fired by global axios interceptor.
    }
  }

  return (
    <div className="page-container">
      <SectionHeader title="Settings & Administration" subtitle="Manage organisation, branches, users, and system configuration" />

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {/* ── ORGANISATION ──────────────────────────────────────────── */}
      {tab === 'org' && (
        <div className="grid-2" style={{alignItems:'start'}}>
          <Card title="Organisation Profile">
            <FormRow><FormGroup label="Company Name" required><input className="form-input" value={orgForm.name} onChange={e=>pof('name',e.target.value)} disabled={!can('settings.edit')} /></FormGroup>
            <FormGroup label="GSTIN"><input className="form-input" value={orgForm.gstin} onChange={e=>pof('gstin',e.target.value)} disabled={!can('settings.edit')} /></FormGroup></FormRow>
            <FormRow><FormGroup label="PAN"><input className="form-input" value={orgForm.pan} onChange={e=>pof('pan',e.target.value)} disabled={!can('settings.edit')} /></FormGroup>
            <FormGroup label="State Code"><input className="form-input" value={orgForm.state_code} onChange={e=>pof('state_code',e.target.value)} disabled={!can('settings.edit')} /></FormGroup></FormRow>
            <FormGroup label="Registered Address"><textarea className="form-input" value={orgForm.address} onChange={e=>pof('address',e.target.value)} style={{height:72}} disabled={!can('settings.edit')} /></FormGroup>
            <FormRow><FormGroup label="Phone"><input className="form-input" value={orgForm.phone} onChange={e=>pof('phone',e.target.value)} disabled={!can('settings.edit')} /></FormGroup>
            <FormGroup label="Email"><input className="form-input" type="email" value={orgForm.email} onChange={e=>pof('email',e.target.value)} disabled={!can('settings.edit')} /></FormGroup></FormRow>
            <FormRow><FormGroup label="Website"><input className="form-input" value={orgForm.website} onChange={e=>pof('website',e.target.value)} disabled={!can('settings.edit')} /></FormGroup>
            <FormGroup label="Financial Year"><select className="form-input" value={orgForm.financial_year} onChange={e=>pof('financial_year',e.target.value)} disabled={!can('settings.edit')}><option value="Apr-Mar">Apr–Mar</option><option value="Jan-Dec">Jan–Dec</option></select></FormGroup></FormRow>
            {can('settings.edit') && (
              <div style={{marginTop:6}}>
                <button className="btn btn-primary btn-sm" onClick={saveOrg} disabled={orgSaving || loading}>
                  {orgSaving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            )}
          </Card>
          <div style={{display:'flex',flexDirection:'column',gap:16}}>
            <Card title="Branding">
              <div style={{border:'2px dashed var(--border-default)',borderRadius:12,padding:28,textAlign:'center',cursor:'pointer',color:'var(--text-muted)'}} onClick={()=>toast('File picker…')}>
                <div style={{fontSize:28,marginBottom:8}}>🖼</div>
                <div style={{fontSize:13}}>Upload company logo</div>
                <div style={{fontSize:11.5,marginTop:4}}>PNG, JPG · Max 2MB · Used on invoices</div>
              </div>
            </Card>
            <Card title="System Preferences">
              {[
                {label:'Currency', value:'INR (₹ — Indian Rupee)'},
                {label:'Date Format', value:'DD/MM/YYYY'},
                {label:'Decimal Places', value:'2'},
                {label:'Time Zone', value:'Asia/Kolkata (IST)'},
                {label:'Language', value:'English'},
              ].map(r=>(
                <div key={r.label} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:'1px solid var(--border-subtle)',fontSize:13}}>
                  <span style={{color:'var(--text-muted)'}}>{r.label}</span>
                  <span style={{fontWeight:500,color:'var(--text-primary)'}}>{r.value}</span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}

      {/* ── BRANCHES ──────────────────────────────────────────────── */}
      {tab === 'branches' && (
        <>
          <div style={{display:'flex',justifyContent:'flex-end',marginBottom:14}}>
            {can('settings.edit') && (
              <button className="btn btn-primary btn-sm" onClick={()=>setShowBranch(true)}>+ Add Branch</button>
            )}
          </div>
          <Card bodyPadding={false}>
            <table className="data-table">
              <thead>
                <tr>
                  <SortableHeader label="Branch" sortKey="name" sortBy={branchSortBy} sortOrder={branchSortOrder} onSort={onBranchSort} />
                  <SortableHeader label="Code" sortKey="code" sortBy={branchSortBy} sortOrder={branchSortOrder} onSort={onBranchSort} />
                  <SortableHeader label="Manager" sortKey="manager" sortBy={branchSortBy} sortOrder={branchSortOrder} onSort={onBranchSort} />
                  <SortableHeader label="Phone" sortKey="phone" sortBy={branchSortBy} sortOrder={branchSortOrder} onSort={onBranchSort} />
                  <th>Address</th>
                  <SortableHeader label="Status" sortKey="active" sortBy={branchSortBy} sortOrder={branchSortOrder} onSort={onBranchSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {branchPageRows.map(b=>(
                  <tr key={b.id}>
                    <td><div style={{fontWeight:500,color:'var(--text-primary)',fontSize:13}}>{b.name}</div></td>
                    <td><span className="mono" style={{fontSize:12,color:'var(--accent)'}}>{b.code}</span></td>
                    <td style={{fontSize:12.5}}>{b.manager}</td>
                    <td style={{fontSize:12,color:'var(--text-muted)'}}>{b.phone}</td>
                    <td style={{fontSize:12,color:'var(--text-muted)',maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{b.address}</td>
                    <td><Chip status={b.active?'active':'inactive'}/></td>
                    <td>
                      <div style={{display:'flex',gap:4}}>
                        {can('settings.edit') && (
                          <button className="btn btn-secondary btn-xs" onClick={() => {
                              setEditBranchForm(b)
                              setShowEditBranch(true)
                              }}>Edit</button>
                        )}
                        <button className="btn btn-secondary btn-xs" onClick={()=>toast('Branch settings…')}>Settings</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <PaginationBar
              total={branches.length}
              skip={brSkip}
              limit={brLimit}
              onSkipChange={setBrSkip}
              onLimitChange={setBrLimit}
            />
          </Card>
          <Modal open={showBranch} onClose={()=>setShowBranch(false)} title="Add Branch" icon="🏪" size="md"
            footer={<><button className="btn btn-secondary" onClick={()=>setShowBranch(false)}>Cancel</button><button className="btn btn-primary" onClick={saveBranch}>Save Branch</button></>}>
            <FormRow><FormGroup label="Branch Name" required><input className="form-input" value={branchForm.name} onChange={e=>pbf('name',e.target.value)}/></FormGroup>
            <FormGroup label="Branch Code"><input className="form-input" value={branchForm.code} onChange={e=>pbf('code',e.target.value)} placeholder="e.g. KK"/></FormGroup></FormRow>
            <FormRow><FormGroup label="Manager"><input className="form-input" value={branchForm.manager} onChange={e=>pbf('manager',e.target.value)}/></FormGroup>
            <FormGroup label="Phone"><input className="form-input" value={branchForm.phone} onChange={e=>pbf('phone',e.target.value)}/></FormGroup></FormRow>
            <FormGroup label="Address"><textarea className="form-input" style={{height:72}} value={branchForm.address} onChange={e=>pbf('address',e.target.value)}/></FormGroup>
          </Modal>
          <Modal open={showEditBranch} onClose={() => setShowEditBranch(false)} title="Edit Branch" size="md"
              footer={<><button className="btn btn-secondary" onClick={() => setShowEditBranch(false)}>Cancel</button><button className="btn btn-primary" onClick={updateBranch}>Update Branch</button></>}>
              <FormRow><FormGroup label="Branch Name" required><input className="form-input" value={editBranchForm.name || ""} onChange={e => pbfEdit('name', e.target.value)}/></FormGroup>
              <FormGroup label="Branch Code"><input className="form-input" value={editBranchForm.code || ""} onChange={e => pbfEdit('code', e.target.value)} /></FormGroup></FormRow>
              <FormRow><FormGroup label="Manager"><input className="form-input" value={editBranchForm.manager || ""} onChange={e => pbfEdit('manager', e.target.value)}/></FormGroup>
              <FormGroup label="Phone"><input className="form-input" value={editBranchForm.phone || ""} onChange={e => pbfEdit('phone', e.target.value)}/></FormGroup></FormRow>
              <FormGroup label="Address"><textarea className="form-input" style={{ height: 72 }} value={editBranchForm.address || ""} onChange={e => pbfEdit('address', e.target.value)}/></FormGroup>
          </Modal>
        </>
      )}

      {/* ── USERS & ROLES ─────────────────────────────────────────── */}
      {tab === 'users' && (
        <>
          {/* Toggle lives in the Card header (replacing the redundant "Users" /
              "Roles & Permissions" title). One Card stays mounted across
              toggle flips — only its body swaps — so keyboard focus on the
              toggle is preserved. The titleRight + bodyPadding adapt to the
              active sub-tab.

              NB: Card's title slot renders React elements as-is (no <h4>
              wrapping) — see components/ui/Card. */}
          <Card
            title={
              <SegmentedToggle
                value={usersTab}
                onChange={setUsersTab}
                options={[
                  { id: 'users', label: 'Users' },
                  { id: 'roles', label: 'Roles' },
                ]}
                ariaLabel="Users or Roles section"
              />
            }
            titleRight={
              usersTab === 'users'
                ? (can('users.create')
                    ? <button className="btn btn-primary btn-sm" onClick={() => setShowUser(true)}>+ Add User</button>
                    : null)
                : (can('users.manage_roles')
                    ? <button className="btn btn-primary btn-sm" onClick={openNewRole}>+ Add Role</button>
                    : null)
            }
            bodyPadding={usersTab === 'roles'}
          >
            {usersTab === 'users' && (
              <>
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="User" sortKey="name" sortBy={userSortBy} sortOrder={userSortOrder} onSort={onUserSort} />
                    <SortableHeader label="Role" sortKey="role" sortBy={userSortBy} sortOrder={userSortOrder} onSort={onUserSort} />
                    <SortableHeader label="Branch" sortKey="branch_id" sortBy={userSortBy} sortOrder={userSortOrder} onSort={onUserSort} />
                    <SortableHeader label="Status" sortKey="active" sortBy={userSortBy} sortOrder={userSortOrder} onSort={onUserSort} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u=>{
                    const initials = u.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase()
                    const r = roleForUser(u)
                    const rLabel = r?.label || u.role
                    const rColor = roleColors[u.role] || roleColors[r?.key] || 'var(--accent)'
                    // Branches column: "All branches" badge when all_branches=true,
                    // otherwise a flat chip list of branch names. All chips look
                    // equal — there's no meaningful "primary branch" concept
                    // for end users (users.branch_id mirrors branch_ids[0] purely
                    // for backwards compat; nothing downstream branches on it).
                    // Falls back to the legacy single branch_id for any pre-
                    // migration record.
                    const assigned = Array.isArray(u.branch_ids) && u.branch_ids.length > 0
                      ? u.branch_ids
                      : (u.branch_id ? [u.branch_id] : [])
                    const branchNames = assigned.map(bid => storeBranches.find(b=>b.id===bid)?.name || bid)
                    return (
                    <tr key={u.id}>
                      <td>
                        <div style={{display:'flex',alignItems:'center',gap:10}}>
                          <Avatar initials={initials} size={30} color={rColor} />
                          <div>
                            <div style={{fontWeight:500,color:'var(--text-primary)',fontSize:13}}>{u.name}</div>
                            <div style={{fontSize:11,color:'var(--text-muted)'}}>{u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td><span style={{fontSize:11.5,padding:'3px 9px',borderRadius:20,fontWeight:600,background:rColor+'18',color:rColor}}>{rLabel}</span></td>
                      <td style={{fontSize:12}}>
                        {u.all_branches ? (
                          <span style={{ padding:'2px 9px', borderRadius:20, fontSize:11, fontWeight:600,
                                          background:'var(--accent)18', color:'var(--accent)' }}>
                            All branches
                          </span>
                        ) : branchNames.length === 0 ? (
                          <span style={{ color:'var(--text-muted)' }}>—</span>
                        ) : (
                          <TruncatedChipList
                            items={assigned.map((bid, i) => ({ id: bid, label: branchNames[i] }))}
                            maxVisible={5}
                            popoverTitle="Assigned branches"
                          />
                        )}
                      </td>
                      <td><Chip status={u.active?'active':'inactive'}/></td>
                      <td>
                        <div style={{display:'flex',gap:4}}>
                          {can('users.edit') && (
                            <button className="btn btn-secondary btn-xs" onClick={()=>openEditUser(u)}>Edit</button>
                          )}
                          {can('users.edit') && (
                            <button className="btn btn-secondary btn-xs" onClick={()=>toggleUser(u.id)}>
                              {u.active ? 'Mark as Inactive' : 'Mark as Active'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
              <PaginationBar
                total={userTotal}
                skip={userSkip}
                limit={userLimit}
                onSkipChange={setUserSkip}
                onLimitChange={setUserLimit}
              />
              </>
            )}

            {usersTab === 'roles' && (
              <>
              {roles.length === 0 && (
                <div style={{padding:'12px 0',fontSize:12,color:'var(--text-muted)'}}>No roles yet. Restart backend after seeding.</div>
              )}
              {roles.slice(roleSkip, roleSkip + roleLimit).map((r) => {
                const rColor = roleColors[r.key] || (r.color && `var(--${r.color})`) || 'var(--accent)'
                const granted = (r.permissions || []).join(', ') || '(none)'
                return (
                  <div key={r.id} style={{padding:'10px 12px',background:'var(--bg-raised)',borderRadius:8,marginBottom:8}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                      <span style={{fontSize:11.5,padding:'2px 8px',borderRadius:20,fontWeight:600,background:rColor+'18',color:rColor}}>{r.label}</span>
                      {r.is_system && <Tag color="gray">system</Tag>}
                      <span style={{fontSize:11,color:'var(--text-muted)'}}>· {r.user_count} user{r.user_count===1?'':'s'}</span>
                      <div style={{flex:1}}/>
                      {can('users.manage_roles') && (
                        <button className="btn btn-secondary btn-xs" onClick={()=>openEditRole(r)}>Edit</button>
                      )}
                      {can('users.manage_roles') && (
                        <button
                          className="btn btn-danger btn-xs"
                          onClick={()=>deleteRole(r)}
                          disabled={r.is_system || r.user_count > 0}
                          title={r.is_system ? 'System roles cannot be deleted' : (r.user_count > 0 ? 'Reassign users first' : 'Delete role')}
                          style={{ opacity: (r.is_system || r.user_count > 0) ? 0.4 : 1 }}
                        >Delete</button>
                      )}
                    </div>
                    {r.description && <div style={{fontSize:11.5,color:'var(--text-secondary)',marginBottom:4}}>{r.description}</div>}
                    <div style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5,fontFamily:'DM Mono, monospace'}}>{granted}</div>
                  </div>
                )
              })}
              {roles.length > 0 && (
                <PaginationBar
                  total={roles.length}
                  skip={roleSkip}
                  limit={roleLimit}
                  onSkipChange={setRoleSkip}
                  onLimitChange={setRoleLimit}
                />
              )}
              </>
            )}
          </Card>

          <RoleEditor
            open={showRoleEditor}
            onClose={()=>setShowRoleEditor(false)}
            role={editingRole}
            catalog={permCatalog}
            onSaved={reloadRoles}
          />

          <Modal open={showUser} onClose={()=>setShowUser(false)} title="Add User" icon="👤" size="md"
            footer={<><button className="btn btn-secondary" onClick={()=>setShowUser(false)}>Cancel</button><button className="btn btn-primary" onClick={saveUser}>Create User</button></>}>
            <FormRow><FormGroup label="Full Name" required><input className="form-input" value={userForm.name} onChange={e=>puf('name',e.target.value)}/></FormGroup>
            <FormGroup label="Email" required><input className="form-input" type="email" value={userForm.email} onChange={e=>puf('email',e.target.value)}/></FormGroup></FormRow>
            <FormGroup label="Role" required>
              <select className="form-input" value={userForm.role_id} onChange={e=>puf('role_id',e.target.value)}>
                <option value="">— Select role —</option>
                {roles.filter(r=>r.active!==false).map(r=><option key={r.id} value={r.id}>{r.label}{r.is_system?'':' (custom)'}</option>)}
              </select>
            </FormGroup>
            <FormGroup label="Branches" required>
              <MultiSelect
                options={storeBranches.map(b => ({ id: b.id, label: b.name }))}
                value={userForm.branch_ids}
                onChange={(ids) => puf('branch_ids', ids)}
                placeholder="Choose branches…"
              />
            </FormGroup>
            <FormGroup label="Temporary password" required>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="form-input"
                  type="text"
                  value={userForm.password}
                  onChange={e=>puf('password', e.target.value)}
                  style={{ fontFamily: 'DM Mono, monospace', flex: 1 }}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={()=>puf('password', generateTempPassword())}
                  title="Generate a new random password"
                >
                  Regenerate
                </button>
              </div>
            </FormGroup>
            <AlertBar type="blue" icon="ℹ">
              The user signs in with this temporary password and is required
              to change it on first login. No email is sent — share the password
              with them securely (Signal / WhatsApp / in person, not email).
            </AlertBar>
          </Modal>

          {/* Post-create confirmation. Displays once with the temp password
              and a copy button — admin should grab it now because it's not
              recoverable later (only the bcrypt hash is stored server-side). */}
          <Modal
            open={!!createdUser}
            onClose={()=>setCreatedUser(null)}
            title="User created"
            icon="✅"
            size="sm"
            footer={
              <>
                <button className="btn btn-secondary" onClick={copyTempPassword}>Copy password</button>
                <button className="btn btn-primary" onClick={()=>setCreatedUser(null)}>Got it</button>
              </>
            }
          >
            {createdUser && (
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                  <strong>{createdUser.name}</strong> ({createdUser.email}) was created.
                  Share this temporary password securely &mdash; they&apos;ll be required
                  to change it on first login.
                </div>
                <div style={{
                  padding: '12px 14px',
                  background: 'var(--bg-raised)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 8,
                  fontFamily: 'DM Mono, monospace',
                  fontSize: 15,
                  textAlign: 'center',
                  letterSpacing: '0.04em',
                  userSelect: 'all',
                }}>
                  {createdUser.password}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10 }}>
                  This password won&apos;t be shown again. The server only stores the bcrypt hash.
                </div>
              </div>
            )}
          </Modal>
          <Modal open={showEditUser} onClose={()=>setShowEditUser(false)} title="Edit User" icon="✏️" size="md"
            footer={<><button className="btn btn-secondary" onClick={()=>setShowEditUser(false)}>Cancel</button><button className="btn btn-primary" onClick={saveEditUser}>Update User</button></>}>
            <FormRow><FormGroup label="Full Name" required><input className="form-input" value={editUserForm.name} onChange={e=>peuf('name',e.target.value)}/></FormGroup>
            <FormGroup label="Email" required><input className="form-input" type="email" value={editUserForm.email} onChange={e=>peuf('email',e.target.value)}/></FormGroup></FormRow>
            <FormGroup label="Role" required>
              <select className="form-input" value={editUserForm.role_id} onChange={e=>peuf('role_id',e.target.value)}>
                <option value="">— Select role —</option>
                {roles.filter(r=>r.active!==false).map(r=><option key={r.id} value={r.id}>{r.label}{r.is_system?'':' (custom)'}</option>)}
              </select>
            </FormGroup>
            <FormGroup label="Branches" required>
              <MultiSelect
                options={storeBranches.map(b => ({ id: b.id, label: b.name }))}
                value={editUserForm.branch_ids}
                onChange={(ids) => peuf('branch_ids', ids)}
                placeholder="Choose branches…"
              />
            </FormGroup>
          </Modal>
        </>
      )}

      {tab === 'tax'       && <TaxConfigTab />}
      {tab === 'numbering' && <NumberingTab />}
      {tab === 'invoice'   && <InvoiceTemplateTab />}
    </div>
  )
}
