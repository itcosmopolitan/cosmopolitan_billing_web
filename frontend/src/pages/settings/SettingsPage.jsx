import { useState, useEffect, useMemo } from 'react'
import toast from 'react-hot-toast'
import { roleColors } from '@/utils/helpers'
import { usersAPI, branchesAPI, rolesAPI, permissionsAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { SectionHeader, Card, Tabs, Chip, Modal, FormGroup, FormRow, Tag, AlertBar, Avatar, PaginationBar, SortableHeader } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'
import RoleEditor from './RoleEditor'
import { TaxConfigTab, NumberingTab, InvoiceTemplateTab } from './SettingsTabs'

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
  const [showUser, setShowUser] = useState(false)
  const [users, setUsers]     = useState([])
  const [userTotal, setUserTotal] = useState(0)
  const [userSkip, setUserSkip] = useState(0)
  const [userLimit, setUserLimit] = useState(DEFAULT_PAGE_SIZE)
  const [userSortBy, setUserSortBy] = useState('name')
  const [userSortOrder, setUserSortOrder] = useState('asc')
  const [userListVersion, setUserListVersion] = useState(0)
  const [branches, setBranches] = useState([])
  const [brSkip, setBrSkip] = useState(0)
  const [brLimit, setBrLimit] = useState(DEFAULT_PAGE_SIZE)
  // Branches are loaded in full via fetchAllList (small list — used by every
  // dropdown), so sort them client-side rather than re-fetching on every
  // header click.
  const [branchSortBy, setBranchSortBy] = useState('name')
  const [branchSortOrder, setBranchSortOrder] = useState('asc')
  const [showBranch, setShowBranch] = useState(false)
  const [userForm, setUserForm] = useState({ name:'', email:'', role_id:'', branch_id:'', active:true })
  const [branchForm, setBranchForm] = useState({ name:'', code:'', manager:'', phone:'', address:'' })
  // Only the setter is consumed; loading state is internal to the boot effect.
  // eslint-disable-next-line no-unused-vars
  const [loading, setLoading] = useState(true)
  const puf = (k,v) => setUserForm(f=>({...f,[k]:v}))
  const pbf = (k,v) => setBranchForm(f=>({...f,[k]:v}))
  const [showEditBranch, setShowEditBranch] = useState(false)
  const [editBranchForm, setEditBranchForm] = useState({})
  const [showEditUser, setShowEditUser] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [editUserForm, setEditUserForm] = useState({ name:'', email:'', role_id:'', branch_id:'' })
  const peuf = (k,v) => setEditUserForm(f=>({...f,[k]:v}))

  // RBAC: roles + permission catalog (Phase 1 of Users & Roles)
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
    } catch (err) {
      console.error(err)
      toast.error('Failed to load branches')
    }
  }

  const reloadRoles = async () => {
    try { setRoles(await rolesAPI.list()) } catch (e) { console.error(e) }
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

  useEffect(() => {
    (async () => {
      try {
        setLoading(true)
        // Load branches (paginated upstream, fetched in full here for the
        // dropdowns) and the RBAC roles + permission catalog in parallel.
        // Users are paginated separately by the next useEffect.
        const [, rolesData, catalogData] = await Promise.all([
          loadAllBranches(),
          rolesAPI.list().catch(() => []),
          permissionsAPI.catalog().catch(() => ({})),
        ])
        setRoles(rolesData || [])
        setPermCatalog(catalogData || {})
      } finally {
        setLoading(false)
      }
    })()
    // setRoles + setPermCatalog are stable Zustand setters; loadAllBranches
    // is a top-level fn that doesn't change between renders. Boot-once
    // intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
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
  }, [userSkip, userLimit, userListVersion, userSortBy, userSortOrder])

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

  const [orgForm, setOrgForm] = useState({
    name: 'Sri Murugan Traders Pvt Ltd',
    gstIn: '33AAZCS1429R1Z1',
    pan: 'AAZCS1429R',
    address: '12, Anna Nagar West, Chennai — 600 040',
    phone: '044-2626 1234',
    email: 'accounts@srimurugan.com',
    website: 'www.srimurugan.com',
    stateCode: '33',
    financialYear: 'Apr–Mar',
  })
  const pof = (k,v) => setOrgForm(f=>({...f,[k]:v}))

  const saveOrg = () => toast.success('Organisation profile saved')

  const saveUser = async () => {
    if (!userForm.name || !userForm.email) { toast.error('Name and email required'); return }
    if (!userForm.role_id) { toast.error('Select a role'); return }

    try {
      const payload = {
        name: userForm.name,
        email: userForm.email,
        role_id: userForm.role_id,
        branch_id: userForm.branch_id || null
      }
      await usersAPI.create(payload)
      setUserSkip(0)
      setUserListVersion((v) => v + 1)
      await loadAllBranches()
      toast.success('User created successfully')
      setShowUser(false)
      setUserForm({ name:'', email:'', role_id:'', branch_id:'', active:true })
    } catch (err) {
      console.error(err)
      // toast already fired by global axios interceptor on non-2xx
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
    setEditUserForm({
      name: user.name,
      email: user.email,
      role_id: user.role_id || roleForUser(user)?.id || '',
      branch_id: user.branch_id || '',
    })
    setShowEditUser(true)
  }

  const saveEditUser = async () => {
    if (!editUserForm.name || !editUserForm.email) { toast.error('Name and email required'); return }
    if (!editUserForm.role_id) { toast.error('Select a role'); return }

    try {
      const payload = {
        name: editUserForm.name,
        email: editUserForm.email,
        role_id: editUserForm.role_id,
        branch_id: editUserForm.branch_id || null
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
            <FormRow><FormGroup label="Company Name" required><input className="form-input" value={orgForm.name} onChange={e=>pof('name',e.target.value)} /></FormGroup>
            <FormGroup label="GSTIN"><input className="form-input" value={orgForm.gstIn} onChange={e=>pof('gstIn',e.target.value)} /></FormGroup></FormRow>
            <FormRow><FormGroup label="PAN"><input className="form-input" value={orgForm.pan} onChange={e=>pof('pan',e.target.value)} /></FormGroup>
            <FormGroup label="State Code"><input className="form-input" value={orgForm.stateCode} onChange={e=>pof('stateCode',e.target.value)} /></FormGroup></FormRow>
            <FormGroup label="Registered Address"><textarea className="form-input" value={orgForm.address} onChange={e=>pof('address',e.target.value)} style={{height:72}}/></FormGroup>
            <FormRow><FormGroup label="Phone"><input className="form-input" value={orgForm.phone} onChange={e=>pof('phone',e.target.value)} /></FormGroup>
            <FormGroup label="Email"><input className="form-input" type="email" value={orgForm.email} onChange={e=>pof('email',e.target.value)} /></FormGroup></FormRow>
            <FormRow><FormGroup label="Website"><input className="form-input" value={orgForm.website} onChange={e=>pof('website',e.target.value)} /></FormGroup>
            <FormGroup label="Financial Year"><select className="form-input" value={orgForm.financialYear} onChange={e=>pof('financialYear',e.target.value)}><option>Apr–Mar</option><option>Jan–Dec</option></select></FormGroup></FormRow>
            <div style={{marginTop:6}}>
              <button className="btn btn-primary btn-sm" onClick={saveOrg}>Save Changes</button>
            </div>
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
                          <button className="btn btn-ghost btn-xs" onClick={() => {
                              setEditBranchForm(b)
                              setShowEditBranch(true)
                              }}>Edit</button>
                        )}
                        <button className="btn btn-ghost btn-xs" onClick={()=>toast('Branch settings…')}>Settings</button>
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
          <div style={{display:'flex',justifyContent:'flex-end',marginBottom:14}}>
            {can('users.create') && (
              <button className="btn btn-primary btn-sm" onClick={()=>setShowUser(true)}>+ Invite User</button>
            )}
          </div>
          <div className="grid-65" style={{alignItems:'start'}}>
            <Card title="Users" bodyPadding={false}>
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="User" sortKey="name" sortBy={userSortBy} sortOrder={userSortOrder} onSort={onUserSort} />
                    <SortableHeader label="Role" sortKey="role" sortBy={userSortBy} sortOrder={userSortOrder} onSort={onUserSort} />
                    <SortableHeader label="Branch" sortKey="branch_id" sortBy={userSortBy} sortOrder={userSortOrder} onSort={onUserSort} />
                    <SortableHeader label="Last Login" sortKey="last_login" sortBy={userSortBy} sortOrder={userSortOrder} onSort={onUserSort} />
                    <SortableHeader label="Status" sortKey="active" sortBy={userSortBy} sortOrder={userSortOrder} onSort={onUserSort} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u=>{
                    const branch = branches.find(b => b.id === u.branch_id)
                    const initials = u.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase()
                    const r = roleForUser(u)
                    const rLabel = r?.label || u.role
                    const rColor = roleColors[u.role] || roleColors[r?.key] || 'var(--accent)'
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
                      <td style={{fontSize:12}}>{branch?.name || 'All Branches'}</td>
                      <td style={{fontSize:11.5,color:'var(--text-muted)'}}>{u.last_login || '—'}</td>
                      <td><Chip status={u.active?'active':'inactive'}/></td>
                      <td>
                        <div style={{display:'flex',gap:4}}>
                          {can('users.edit') && (
                            <button className="btn btn-ghost btn-xs" onClick={()=>openEditUser(u)}>Edit</button>
                          )}
                          {can('users.edit') && (
                            <button className="btn btn-danger btn-xs" onClick={()=>toggleUser(u.id)}>{u.active?'Disable':'Enable'}</button>
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
            </Card>
            <Card
              title="Roles & Permissions"
              titleRight={can('users.manage_roles') ? <button className="btn btn-primary btn-xs" onClick={openNewRole}>+ New Role</button> : null}
            >
              {roles.length === 0 && (
                <div style={{padding:'12px 0',fontSize:12,color:'var(--text-muted)'}}>No roles yet. Restart backend after seeding.</div>
              )}
              {roles.map((r) => {
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
                        <button className="btn btn-ghost btn-xs" onClick={()=>openEditRole(r)}>Edit</button>
                      )}
                      {can('users.manage_roles') && (
                        <button
                          className="btn btn-ghost btn-xs"
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
            </Card>
            <RoleEditor
              open={showRoleEditor}
              onClose={()=>setShowRoleEditor(false)}
              role={editingRole}
              catalog={permCatalog}
              onSaved={reloadRoles}
            />
          </div>
          <Modal open={showUser} onClose={()=>setShowUser(false)} title="Invite User" icon="👤" size="md"
            footer={<><button className="btn btn-secondary" onClick={()=>setShowUser(false)}>Cancel</button><button className="btn btn-primary" onClick={saveUser}>Create User</button></>}>
            <FormRow><FormGroup label="Full Name" required><input className="form-input" value={userForm.name} onChange={e=>puf('name',e.target.value)}/></FormGroup>
            <FormGroup label="Email" required><input className="form-input" type="email" value={userForm.email} onChange={e=>puf('email',e.target.value)}/></FormGroup></FormRow>
            <FormRow>
              <FormGroup label="Role" required>
                <select className="form-input" value={userForm.role_id} onChange={e=>puf('role_id',e.target.value)}>
                  <option value="">— Select role —</option>
                  {roles.filter(r=>r.active!==false).map(r=><option key={r.id} value={r.id}>{r.label}{r.is_system?'':' (custom)'}</option>)}
                </select>
              </FormGroup>
              <FormGroup label="Branch">
                <select className="form-input" value={userForm.branch_id} onChange={e=>puf('branch_id',e.target.value)}>
                  <option value="">All Branches</option>
                  {branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </FormGroup>
            </FormRow>
            <AlertBar type="blue" icon="ℹ">An invitation email will be sent to the user with a secure login link.</AlertBar>
          </Modal>
          <Modal open={showEditUser} onClose={()=>setShowEditUser(false)} title="Edit User" icon="✏️" size="md"
            footer={<><button className="btn btn-secondary" onClick={()=>setShowEditUser(false)}>Cancel</button><button className="btn btn-primary" onClick={saveEditUser}>Update User</button></>}>
            <FormRow><FormGroup label="Full Name" required><input className="form-input" value={editUserForm.name} onChange={e=>peuf('name',e.target.value)}/></FormGroup>
            <FormGroup label="Email" required><input className="form-input" type="email" value={editUserForm.email} onChange={e=>peuf('email',e.target.value)}/></FormGroup></FormRow>
            <FormRow>
              <FormGroup label="Role" required>
                <select className="form-input" value={editUserForm.role_id} onChange={e=>peuf('role_id',e.target.value)}>
                  <option value="">— Select role —</option>
                  {roles.filter(r=>r.active!==false).map(r=><option key={r.id} value={r.id}>{r.label}{r.is_system?'':' (custom)'}</option>)}
                </select>
              </FormGroup>
              <FormGroup label="Branch">
                <select className="form-input" value={editUserForm.branch_id} onChange={e=>peuf('branch_id',e.target.value)}>
                  <option value="">All Branches</option>
                  {branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </FormGroup>
            </FormRow>
          </Modal>
        </>
      )}

      {tab === 'tax'       && <TaxConfigTab />}
      {tab === 'numbering' && <NumberingTab />}
      {tab === 'invoice'   && <InvoiceTemplateTab />}
    </div>
  )
}
