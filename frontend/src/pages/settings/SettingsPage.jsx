import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { TAX_RATES, ROLES } from '@/utils/seedData'
import { roleColors, roleLabels } from '@/utils/helpers'
import { usersAPI, branchesAPI } from '@/api'
import { SectionHeader, Card, Tabs, Chip, Modal, FormGroup, FormRow, Tag, AlertBar, Avatar } from '@/components/ui'

const TABS = [
  { id: 'org',      label: '🏢 Organisation' },
  { id: 'branches', label: '🏪 Branches' },
  { id: 'users',    label: '👥 Users & Roles' },
  { id: 'tax',      label: '🧾 Tax Config' },
  { id: 'numbering',label: '🔢 Document Numbering' },
  { id: 'invoice',  label: '🖨 Invoice Template' },
]


export default function SettingsPage() {
  const [tab, setTab]         = useState('org')
  const [showUser, setShowUser] = useState(false)
  const [users, setUsers]     = useState([])
  const [branches, setBranches] = useState([])
  const [showBranch, setShowBranch] = useState(false)
  const [userForm, setUserForm] = useState({ name:'', email:'', role:'cashier', branch_id:'', active:true })
  const [branchForm, setBranchForm] = useState({ name:'', code:'', manager:'', phone:'', address:'' })
  const [loading, setLoading] = useState(true)
  const puf = (k,v) => setUserForm(f=>({...f,[k]:v}))
  const pbf = (k,v) => setBranchForm(f=>({...f,[k]:v}))
  const [showEditBranch, setShowEditBranch] = useState(false)
  const [editBranchForm, setEditBranchForm] = useState({})
  const [showEditUser, setShowEditUser] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [editUserForm, setEditUserForm] = useState({ name:'', email:'', role:'cashier', branch_id:'' })
  const peuf = (k,v) => setEditUserForm(f=>({...f,[k]:v}))

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      setLoading(true)
      const [usersData, branchesData] = await Promise.all([
        usersAPI.list().catch(() => []),
        branchesAPI.list().catch(() => [])
      ])
      setUsers(usersData || [])
      setBranches(branchesData || [])
    } catch (err) {
      console.error(err)
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const fetchBranches = async () => {
    try {
      const data = await branchesAPI.list()
      setBranches(data)
    } 
    catch (err) {
      console.error(err)
      toast.error('Failed to load branches')
    }
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
    if (!userForm.role) { toast.error('Select a role'); return }
    
    try {
      const payload = {
        name: userForm.name,
        email: userForm.email,
        role: userForm.role,
        branch_id: userForm.branch_id || null
      }
      await usersAPI.create(payload)
      await fetchData()
      toast.success('User created successfully')
      setShowUser(false)
      setUserForm({ name:'', email:'', role:'cashier', branch_id:'', active:true })
    } catch (err) {
      console.error(err)
      toast.error('Failed to create user')
    }
  }

  const toggleUser = async (userId) => {
    try {
      await usersAPI.toggle(userId)
      await fetchData()
      toast.success('User status updated')
    } catch (err) {
      console.error(err)
      toast.error('Failed to update user')
    }
  }

  const openEditUser = (user) => {
    setEditingUser(user)
    setEditUserForm({ name: user.name, email: user.email, role: user.role, branch_id: user.branch_id || '' })
    setShowEditUser(true)
  }

  const saveEditUser = async () => {
    if (!editUserForm.name || !editUserForm.email) { toast.error('Name and email required'); return }
    if (!editUserForm.role) { toast.error('Select a role'); return }
    
    try {
      const payload = {
        name: editUserForm.name,
        email: editUserForm.email,
        role: editUserForm.role,
        branch_id: editUserForm.branch_id || null
      }
      await usersAPI.update(editingUser.id, payload)
      await fetchData()
      toast.success('User updated successfully')
      setShowEditUser(false)
      setEditingUser(null)
    } catch (err) {
      console.error(err)
      toast.error('Failed to update user')
    }
  }

    const saveBranch = async () => {
        try {
            const res = await fetch('http://localhost:8080/api/v1/branches/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: branchForm.name,
                    code: branchForm.code,
                    manager: branchForm.manager,
                    phone: branchForm.phone,
                    address: branchForm.address,
                    gstin: "",
                    active: true
                })
            })

            if (!res.ok) {
                throw new Error('API failed')
            }
            await res.json()
            // ✅ CLOSE MODAL HERE
            setShowBranch(false)
            // ✅ refresh data
            fetchBranches()
            toast.success('Branch added')
        }
        catch (err) {
            console.error(err)
            toast.error('Failed to add branch')
        }
    }

    const updateBranch = async () => {
        try {
            const res = await fetch(`http://localhost:8080/api/v1/branches/${editBranchForm.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: editBranchForm.name,
                    code: editBranchForm.code,
                    manager: editBranchForm.manager,
                    phone: editBranchForm.phone,
                    address: editBranchForm.address,
                    gstin: editBranchForm.gstin || "",
                    active: editBranchForm.active ?? true
                })
            })
            if (!res.ok) throw new Error("Update failed")
            toast.success("Branch updated")
            setShowEditBranch(false)
            fetchBranches() // refresh list
        }
        catch (err) {
            console.error(err)
            toast.error("Failed to update branch")
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
            <button className="btn btn-primary btn-sm" onClick={()=>setShowBranch(true)}>+ Add Branch</button>
          </div>
          <Card bodyPadding={false}>
            <table className="data-table">
              <thead><tr><th>Branch</th><th>Code</th><th>Manager</th><th>Phone</th><th>Address</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {branches.map(b=>(
                  <tr key={b.id}>
                    <td><div style={{fontWeight:500,color:'var(--text-primary)',fontSize:13}}>{b.name}</div></td>
                    <td><span className="mono" style={{fontSize:12,color:'var(--accent)'}}>{b.code}</span></td>
                    <td style={{fontSize:12.5}}>{b.manager}</td>
                    <td style={{fontSize:12,color:'var(--text-muted)'}}>{b.phone}</td>
                    <td style={{fontSize:12,color:'var(--text-muted)',maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{b.address}</td>
                    <td><Chip status={b.active?'active':'inactive'}/></td>
                    <td>
                      <div style={{display:'flex',gap:4}}>
                        <button className="btn btn-ghost btn-xs" onClick={() => {
                            setEditBranchForm(b)
                            setShowEditBranch(true)
                            }}>Edit</button>
                        <button className="btn btn-ghost btn-xs" onClick={()=>toast('Branch settings…')}>Settings</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
            <button className="btn btn-primary btn-sm" onClick={()=>setShowUser(true)}>+ Invite User</button>
          </div>
          <div className="grid-65" style={{alignItems:'start'}}>
            <Card title="Users" bodyPadding={false}>
              <table className="data-table">
                <thead><tr><th>User</th><th>Role</th><th>Branch</th><th>Last Login</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {users.map(u=>{
                    const branch = branches.find(b => b.id === u.branch_id)
                    const initials = u.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase()
                    return (
                    <tr key={u.id}>
                      <td>
                        <div style={{display:'flex',alignItems:'center',gap:10}}>
                          <Avatar initials={initials} size={30} color={roleColors[u.role]||'var(--accent)'} />
                          <div>
                            <div style={{fontWeight:500,color:'var(--text-primary)',fontSize:13}}>{u.name}</div>
                            <div style={{fontSize:11,color:'var(--text-muted)'}}>{u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td><span style={{fontSize:11.5,padding:'3px 9px',borderRadius:20,fontWeight:600,background:(roleColors[u.role]||'var(--accent)')+'18',color:roleColors[u.role]||'var(--accent)'}}>{roleLabels[u.role]||u.role}</span></td>
                      <td style={{fontSize:12}}>{branch?.name || 'All Branches'}</td>
                      <td style={{fontSize:11.5,color:'var(--text-muted)'}}>{u.last_login || '—'}</td>
                      <td><Chip status={u.active?'active':'inactive'}/></td>
                      <td>
                        <div style={{display:'flex',gap:4}}>
                          <button className="btn btn-ghost btn-xs" onClick={()=>openEditUser(u)}>Edit</button>
                          <button className="btn btn-danger btn-xs" onClick={()=>toggleUser(u.id)}>{u.active?'Disable':'Enable'}</button>
                        </div>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </Card>
            <Card title="Roles & Permissions">
              {Object.entries(ROLES).map(([key, r]) => (
                <div key={key} style={{padding:'10px 12px',background:'var(--bg-raised)',borderRadius:8,marginBottom:8}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                    <span style={{fontSize:11.5,padding:'2px 8px',borderRadius:20,fontWeight:600,background:(roleColors[key]||'var(--accent)')+'18',color:roleColors[key]||'var(--accent)'}}>{r.label}</span>
                  </div>
                  <div style={{fontSize:11.5,color:'var(--text-muted)',lineHeight:1.5}}>{r.permissions.join(', ')}</div>
                </div>
              ))}
            </Card>
          </div>
          <Modal open={showUser} onClose={()=>setShowUser(false)} title="Invite User" icon="👤" size="md"
            footer={<><button className="btn btn-secondary" onClick={()=>setShowUser(false)}>Cancel</button><button className="btn btn-primary" onClick={saveUser}>Create User</button></>}>
            <FormRow><FormGroup label="Full Name" required><input className="form-input" value={userForm.name} onChange={e=>puf('name',e.target.value)}/></FormGroup>
            <FormGroup label="Email" required><input className="form-input" type="email" value={userForm.email} onChange={e=>puf('email',e.target.value)}/></FormGroup></FormRow>
            <FormRow>
              <FormGroup label="Role">
                <select className="form-input" value={userForm.role} onChange={e=>puf('role',e.target.value)}>
                  {Object.entries(ROLES).map(([k,r])=><option key={k} value={k}>{r.label}</option>)}
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
              <FormGroup label="Role">
                <select className="form-input" value={editUserForm.role} onChange={e=>peuf('role',e.target.value)}>
                  {Object.entries(ROLES).map(([k,r])=><option key={k} value={k}>{r.label}</option>)}
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

      {/* ── TAX CONFIG ────────────────────────────────────────────── */}
      {tab === 'tax' && (
        <>
          <AlertBar type="blue" icon="ℹ" style={{marginBottom:16}}>Tax rates are used for invoice calculations and GST reports only. RetailOS does not file returns or integrate with government portals.</AlertBar>
          <Card title="GST Rate Configuration" bodyPadding={false}>
            <table className="data-table">
              <thead><tr><th>Rate</th><th>Description</th><th>HSN Examples</th><th>Applicable To</th><th></th></tr></thead>
              <tbody>
                {TAX_RATES.map(r=>(
                  <tr key={r.rate}>
                    <td><span style={{fontSize:14,fontWeight:700,fontFamily:'DM Mono',color:'var(--accent)'}}>{r.rate}%</span></td>
                    <td><span style={{fontWeight:500}}>{r.label}</span></td>
                    <td style={{fontSize:12,color:'var(--text-muted)',fontFamily:'DM Mono'}}>{r.examples.split(',')[0]}</td>
                    <td style={{fontSize:12.5,color:'var(--text-secondary)'}}>{r.examples}</td>
                    <td><button className="btn btn-ghost btn-xs">Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <div style={{height:16}}/>
          <Card title="Other Tax Settings">
            {[
              {label:'Tax Inclusive Pricing', desc:'Show prices inclusive of GST at POS', value:'Off'},
              {label:'Auto-calculate GST on purchases', desc:'Apply tax rates automatically on purchase entry', value:'On'},
              {label:'Show HSN Code on invoices', desc:'Print HSN/SAC codes on sales invoices', value:'On'},
              {label:'CGST + SGST split on invoices', desc:'Show tax breakup as CGST and SGST separately', value:'On'},
            ].map(r=>(
              <div key={r.label} style={{display:'flex',alignItems:'center',padding:'12px 0',borderBottom:'1px solid var(--border-subtle)'}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:13.5,fontWeight:500,color:'var(--text-primary)'}}>{r.label}</div>
                  <div style={{fontSize:12,color:'var(--text-muted)',marginTop:2}}>{r.desc}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={()=>toast('Toggle setting')}>{r.value}</button>
              </div>
            ))}
          </Card>
        </>
      )}

      {/* ── DOCUMENT NUMBERING ────────────────────────────────────── */}
      {tab === 'numbering' && (
        <Card title="Document Number Formats">
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {[
              {doc:'Sales Invoice', prefix:'INV', format:'INV-YYYY-####', sample:'INV-2024-1847', branch:'Per Branch'},
              {doc:'Purchase Bill', prefix:'PUR', format:'PUR-YYYY-####', sample:'PUR-2024-0412', branch:'Centralised'},
              {doc:'POS Receipt',   prefix:'POS', format:'POS-YYYY-####', sample:'POS-2024-1848', branch:'Per Branch'},
              {doc:'Stock Transfer',prefix:'TRF', format:'TRF-YYYY-###',  sample:'TRF-2024-041',  branch:'Centralised'},
              {doc:'Credit Note',   prefix:'CN',  format:'CN-YYYY-####',  sample:'CN-2024-0012',  branch:'Per Branch'},
              {doc:'Quotation',     prefix:'QT',  format:'QT-YYYY-####',  sample:'QT-2024-0088',  branch:'Per Branch'},
            ].map(r=>(
              <div key={r.doc} style={{display:'grid',gridTemplateColumns:'160px 140px 160px 140px auto',alignItems:'center',gap:12,padding:'10px 14px',background:'var(--bg-raised)',borderRadius:8}}>
                <span style={{fontSize:13,fontWeight:500,color:'var(--text-primary)'}}>{r.doc}</span>
                <span style={{fontSize:12,fontFamily:'DM Mono',color:'var(--accent)'}}>{r.format}</span>
                <span style={{fontSize:12,fontFamily:'DM Mono',color:'var(--text-muted)'}}>{r.sample}</span>
                <span style={{fontSize:11.5}}><Tag>{r.branch}</Tag></span>
                <button className="btn btn-ghost btn-xs" onClick={()=>toast('Edit format')}>Edit</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── INVOICE TEMPLATE ──────────────────────────────────────── */}
      {tab === 'invoice' && (
        <div className="grid-2" style={{alignItems:'start'}}>
          <Card title="Invoice Template Settings">
            {[
              {label:'Header',        options:['Company name + logo','Logo only','Name only']},
              {label:'Show HSN Codes',options:['Yes','No']},
              {label:'Show Item Desc',options:['Yes','No']},
              {label:'Tax Display',   options:['CGST+SGST','Integrated GST','Total GST only']},
              {label:'Footer Text',   type:'textarea', value:'Thank you for your business!\nGoods once sold cannot be returned.'},
              {label:'Terms',         type:'textarea', value:'Payment due within 30 days. Interest @ 2% per month on overdue.'},
            ].map(r=>(
              <div key={r.label} style={{marginBottom:12}}>
                <label className="form-label">{r.label}</label>
                {r.type==='textarea'
                  ? <textarea className="form-input" defaultValue={r.value} style={{height:64}}/>
                  : <select className="form-input"><option>{r.options[0]}</option>{r.options.slice(1).map(o=><option key={o}>{o}</option>)}</select>
                }
              </div>
            ))}
            <button className="btn btn-primary btn-sm" onClick={()=>toast('Template settings saved')}>Save Template</button>
          </Card>
          <Card title="Invoice Preview">
            <div style={{border:'1px solid var(--border-default)',borderRadius:10,padding:20,fontFamily:'DM Mono',fontSize:11.5,background:'var(--bg-raised)',lineHeight:1.7}}>
              <div style={{textAlign:'center',marginBottom:10}}>
                <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>SRI MURUGAN TRADERS PVT LTD</div>
                <div>12, Anna Nagar West, Chennai — 600 040</div>
                <div>GSTIN: 33AAZCS1429R1Z1 | Ph: 044-2626 1234</div>
              </div>
              <div style={{textAlign:'center',fontWeight:700,borderTop:'1px solid var(--border-default)',borderBottom:'1px solid var(--border-default)',padding:'4px 0',margin:'8px 0'}}>TAX INVOICE</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
                <div><div>Invoice #: INV-2024-1847</div><div>Date: 16/04/2024</div></div>
                <div><div>Customer: Rajesh Stores</div><div>GSTIN: 33ABCDE1234F1Z5</div></div>
              </div>
              <table style={{width:'100%',borderCollapse:'collapse',marginBottom:8}}>
                <thead><tr>{['Item','Qty','Rate','GST','Amount'].map(h=><th key={h} style={{padding:'4px 6px',borderBottom:'1px solid var(--border-default)',textAlign:h==='Item'?'left':'right'}}>{h}</th>)}</tr></thead>
                <tbody>
                  <tr>{['Basmati Rice 5kg','20','₹299','0%','₹5,980'].map((c,i)=><td key={i} style={{padding:'3px 6px',textAlign:i===0?'left':'right'}}>{c}</td>)}</tr>
                </tbody>
              </table>
              <div style={{textAlign:'right',borderTop:'1px solid var(--border-default)',paddingTop:6}}>
                <div>Subtotal: ₹5,980 | CGST: ₹0 | SGST: ₹0</div>
                <div style={{fontWeight:700,fontSize:13}}>Total: ₹5,980</div>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
