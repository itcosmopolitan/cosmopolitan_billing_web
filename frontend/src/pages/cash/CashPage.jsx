import { useState, useMemo } from 'react'
import toast from 'react-hot-toast'
import { CASH_ENTRIES, BRANCHES } from '@/utils/seedData'
import { fmt } from '@/utils/helpers'
import { SectionHeader, Card, KPICard, BarList, Modal, FormGroup, FormRow, EmptyState, Chip, AlertBar } from '@/components/ui'

const WEEK_DATA = [
  { label:'Apr 10', value:56200 },{ label:'Apr 11', value:48800 },{ label:'Apr 12', value:64400 },
  { label:'Apr 13', value:42000 },{ label:'Apr 14', value:76400 },{ label:'Apr 15', value:61600 },
  { label:'Today',  value:62640 },
]

export default function CashPage() {
  const [branch, setBranch]     = useState('br-001')
  const [showEntry, setShowEntry] = useState(false)
  const [showClose, setShowClose] = useState(false)
  const [entries, setEntries]   = useState(CASH_ENTRIES)
  const [form, setForm]         = useState({ type:'out', category:'Vendor Payment', description:'', amount:'', ref:'' })
  const pf = (k,v) => setForm(f=>({...f,[k]:v}))

  const branchEntries = useMemo(() => entries.filter(e => e.branchId === branch), [entries, branch])

  const totals = useMemo(() => {
    const open    = branchEntries.find(e => e.category === 'Opening Balance')?.amount || 0
    const cashIn  = branchEntries.filter(e => e.type === 'in').reduce((s,e) => s+e.amount, 0)
    const cashOut = branchEntries.filter(e => e.type === 'out').reduce((s,e) => s+e.amount, 0)
    const expected = open + cashIn - cashOut
    const actual   = expected // no variance today
    return { open, cashIn, cashOut, expected, actual, variance: actual - expected }
  }, [branchEntries])

  const saveEntry = () => {
    if (!form.amount || Number(form.amount) <= 0) { toast.error('Enter amount'); return }
    if (!form.description) { toast.error('Enter description'); return }
    setEntries(list => [...list, {
      id:'ce-'+Date.now(), branchId:branch, type:form.type, category:form.category,
      description:form.description, amount:Number(form.amount), ref:form.ref,
      date:'2024-04-16', time:new Date().toTimeString().slice(0,5), by:'Arjun M.',
    }])
    toast.success('Cash entry recorded')
    setShowEntry(false)
    setForm({ type:'out', category:'Vendor Payment', description:'', amount:'', ref:'' })
  }

  const closeDay = () => {
    toast.success('Day closed. Cash reconciliation report generated. Variance: ₹0.')
    setShowClose(false)
  }

  const selectedBranch = BRANCHES.find(b=>b.id===branch)

  return (
    <div className="page-container">
      <SectionHeader title="Cash Control" subtitle="Daily petty cash register, entries, and day-close reconciliation">
        <select className="form-input" style={{width:160}} value={branch} onChange={e=>setBranch(e.target.value)}>
          {BRANCHES.filter(b=>b.id!=='br-005').map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button className="btn btn-secondary btn-sm" onClick={()=>setShowEntry(true)}>+ Cash Entry</button>
        <button className="btn btn-primary btn-sm" onClick={()=>setShowClose(true)}>Close Day</button>
      </SectionHeader>

      {totals.variance !== 0 && <AlertBar type={Math.abs(totals.variance)>500?'red':'amber'} icon="⚠️" style={{marginBottom:16}}>Cash variance detected: <strong>{fmt(Math.abs(totals.variance))}</strong> {totals.variance<0?'shortage':'excess'}. Please recount and update.</AlertBar>}

      {/* Summary cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:12, marginBottom:20 }}>
        {[
          { label:'Opening Balance', value:fmt(totals.open),     color:'var(--teal)' },
          { label:'Cash Sales',      value:fmt(totals.cashIn - totals.open), color:'var(--green)' },
          { label:'Cash Expenses',   value:fmt(totals.cashOut),  color:'var(--red)' },
          { label:'Expected Cash',   value:fmt(totals.expected), color:'var(--text-primary)' },
          { label:'Actual Cash',     value:fmt(totals.actual),   color:'var(--green)' },
          { label:'Variance',        value:fmt(totals.variance), color: totals.variance===0?'var(--green)':'var(--red)' },
        ].map(c=>(
          <div key={c.label} style={{background:'var(--bg-surface)',border:'1px solid var(--border-default)',borderRadius:10,padding:'14px 16px',textAlign:'center'}}>
            <div style={{fontSize:11,color:'var(--text-muted)',marginBottom:6}}>{c.label}</div>
            <div style={{fontSize:18,fontWeight:700,color:c.color,fontFamily:'DM Mono,monospace'}}>{c.value}</div>
          </div>
        ))}
      </div>

      <div className="grid-2">
        <Card title={`Cash Entries — ${selectedBranch?.name} — Apr 16`} titleRight={<span style={{fontSize:11,color:'var(--text-muted)'}}>All amounts in ₹</span>} bodyPadding={false}>
          {branchEntries.length === 0 ? <EmptyState icon="💰" title="No entries today" /> : (
            <table className="data-table">
              <thead><tr><th>Time</th><th>Type</th><th>Category</th><th>Description</th><th className="text-right">Amount</th><th>By</th></tr></thead>
              <tbody>
                {branchEntries.map(e=>(
                  <tr key={e.id}>
                    <td style={{fontSize:12,fontFamily:'DM Mono,monospace',color:'var(--text-muted)'}}>{e.time}</td>
                    <td><Chip status={e.type==='in'?'paid':'overdue'} label={e.type==='in'?'In':'Out'}/></td>
                    <td><span style={{fontSize:11.5,color:'var(--text-muted)'}}>{e.category}</span></td>
                    <td style={{fontSize:12.5}}>{e.description}</td>
                    <td className="text-right mono" style={{fontWeight:600,color:e.type==='in'?'var(--green)':'var(--red)'}}>
                      {e.type==='in'?'+':'-'}{fmt(e.amount)}
                    </td>
                    <td style={{fontSize:11.5,color:'var(--text-muted)'}}>{e.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{padding:'12px 16px',borderTop:'1px solid var(--border-subtle)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span style={{fontSize:12,color:'var(--text-muted)'}}>{branchEntries.length} entries</span>
            <div style={{display:'flex',gap:16,fontSize:13}}>
              <span>In: <strong style={{color:'var(--green)'}}>{fmt(totals.cashIn)}</strong></span>
              <span>Out: <strong style={{color:'var(--red)'}}>{fmt(totals.cashOut)}</strong></span>
              <span>Balance: <strong style={{color:'var(--accent)'}}>{fmt(totals.expected)}</strong></span>
            </div>
          </div>
        </Card>

        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          <Card title="7-Day Cash Trend">
            <BarList items={WEEK_DATA.map((d,i)=>({label:d.label,value:d.value,color:i===6?'var(--accent)':'var(--teal)'}))} valueFormatter={v=>fmt(v)} />
          </Card>
          <Card title="Expense Breakdown">
            <BarList items={[
              {label:'Vendor Pay',  value:1800, color:'var(--purple)'},
              {label:'Electricity', value:2400, color:'var(--amber)'},
              {label:'Transport',   value:360,  color:'var(--blue)'},
              {label:'Stationery',  value:200,  color:'var(--teal)'},
            ]} valueFormatter={v=>fmt(v)} />
          </Card>
        </div>
      </div>

      {/* Cash Entry Modal */}
      <Modal open={showEntry} onClose={()=>setShowEntry(false)} title="New Cash Entry" icon="💰" size="sm"
        footer={<><button className="btn btn-secondary" onClick={()=>setShowEntry(false)}>Cancel</button><button className="btn btn-primary" onClick={saveEntry}>Save Entry</button></>}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:14}}>
          {[{id:'in',label:'💵 Cash In'},{id:'out',label:'💸 Cash Out'}].map(t=>(
            <button key={t.id} onClick={()=>pf('type',t.id)}
              style={{padding:10,borderRadius:8,border:`1.5px solid ${form.type===t.id?'var(--accent)':'var(--border-default)'}`,background:form.type===t.id?'var(--accent-bg)':'transparent',color:form.type===t.id?'var(--accent)':'var(--text-muted)',cursor:'pointer',fontFamily:'DM Sans,sans-serif',fontSize:13,fontWeight:500}}>
              {t.label}
            </button>
          ))}
        </div>
        <FormGroup label="Amount (₹)" required><input className="form-input" type="number" value={form.amount} onChange={e=>pf('amount',e.target.value)} autoFocus placeholder="0.00" /></FormGroup>
        <FormGroup label="Category">
          <select className="form-input" value={form.category} onChange={e=>pf('category',e.target.value)}>
            {(form.type==='out'
              ? ['Vendor Payment','Electricity','Water','Stationery','Transport','Staff Advance','Repairs','Miscellaneous']
              : ['Opening Balance','Cash Sale','Customer Payment','Other Income']
            ).map(c=><option key={c}>{c}</option>)}
          </select>
        </FormGroup>
        <FormGroup label="Description" required><input className="form-input" value={form.description} onChange={e=>pf('description',e.target.value)} placeholder="Brief description" /></FormGroup>
        <FormGroup label="Reference / Bill Number"><input className="form-input" value={form.ref} onChange={e=>pf('ref',e.target.value)} placeholder="Optional" /></FormGroup>
      </Modal>

      {/* Day Close Modal */}
      <Modal open={showClose} onClose={()=>setShowClose(false)} title="Close Day — Cash Reconciliation" icon="🔒" size="sm"
        footer={<><button className="btn btn-secondary" onClick={()=>setShowClose(false)}>Cancel</button><button className="btn btn-primary" onClick={closeDay}>Confirm Day Close</button></>}>
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {[
            {label:'Opening Balance', value:fmt(totals.open)},
            {label:'Total Cash In',   value:fmt(totals.cashIn),  color:'var(--green)'},
            {label:'Total Cash Out',  value:fmt(totals.cashOut), color:'var(--red)'},
            {label:'Expected Closing',value:fmt(totals.expected)},
          ].map(r=>(
            <div key={r.label} style={{display:'flex',justifyContent:'space-between',padding:'10px 14px',background:'var(--bg-raised)',borderRadius:8}}>
              <span style={{fontSize:13,color:'var(--text-secondary)'}}>{r.label}</span>
              <span style={{fontSize:14,fontWeight:600,fontFamily:'DM Mono,monospace',color:r.color||'var(--text-primary)'}}>{r.value}</span>
            </div>
          ))}
        </div>
        <div style={{marginTop:14}}>
          <FormGroup label="Actual Cash in Drawer (₹)"><input className="form-input" type="number" placeholder={String(totals.actual)} /></FormGroup>
          <FormGroup label="Remarks"><textarea className="form-input" style={{height:64}} placeholder="Any notes about the day…" /></FormGroup>
        </div>
      </Modal>
    </div>
  )
}
