import { useState } from 'react'
import toast from 'react-hot-toast'
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell } from 'recharts'
import { SALES_INVOICES, PURCHASE_BILLS, PRODUCTS, BRANCHES, SALES_TREND } from '@/utils/seedData'
import { fmt, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, Tabs, KPICard, BarList, Chip, AlertBar } from '@/components/ui'

const TABS = [
  { id: 'sales',     label: '📈 Sales Register' },
  { id: 'purchase',  label: '📦 Purchase Register' },
  { id: 'tax',       label: '🧾 Tax Summary (GST)' },
  { id: 'stock',     label: '📊 Stock Movement' },
  { id: 'branch',    label: '🏪 Branch Comparison' },
  { id: 'margin',    label: '💹 Margin Analysis' },
]

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background:'var(--bg-raised)', border:'1px solid var(--border-default)', borderRadius:8, padding:'10px 14px', fontSize:12 }}>
      <div style={{ fontWeight:600, marginBottom:5 }}>{label}</div>
      {payload.map(p => <div key={p.name} style={{ color:p.color }}>
        {p.name}: <span style={{ fontFamily:'DM Mono' }}>{fmt(p.value)}</span>
      </div>)}
    </div>
  )
}

// ── Tax data ──────────────────────────────────────────────────────────────────
const TAX_OUTPUT = [
  { rate:'0% (Exempt)', taxable:224000, cgst:0,     sgst:0 },
  { rate:'5%',          taxable:384000, cgst:9600,  sgst:9600 },
  { rate:'12%',         taxable:192000, cgst:11520, sgst:11520 },
  { rate:'18%',         taxable:448000, cgst:40320, sgst:40320 },
]
const TAX_INPUT = [
  { rate:'0% (Exempt)', taxable:144000, cgst:0,     sgst:0 },
  { rate:'5%',          taxable:240000, cgst:6000,  sgst:6000 },
  { rate:'18%',         taxable:288000, cgst:25920, sgst:25920 },
]

// ── Margin data ───────────────────────────────────────────────────────────────
const MARGIN_DATA = PRODUCTS.slice(0, 8).map(p => ({
  name: p.name.split(' ').slice(0,2).join(' '),
  revenue: p.sellingPrice * 100,
  cost: p.costPrice * 100,
  margin: Math.round(((p.sellingPrice - p.costPrice) / p.sellingPrice) * 100),
}))

// ── Category pie ──────────────────────────────────────────────────────────────
const CAT_DATA = [
  { name:'Grains & Pulses', value:42, color:'#6366f1' },
  { name:'Oils & Ghee',     value:18, color:'#a78bfa' },
  { name:'Dairy',           value:15, color:'#2dd4bf' },
  { name:'Snacks',          value:14, color:'#f5a623' },
  { name:'Household',       value:7,  color:'#22c97a' },
  { name:'Beverages',       value:4,  color:'#f5485c' },
]

export default function ReportsPage() {
  const [tab, setTab]       = useState('sales')
  const [dateFrom, setFrom] = useState('2024-04-01')
  const [dateTo, setTo]     = useState('2024-04-16')
  const [branchF, setBranch] = useState('')
  const [filterApplied, setFilterApplied] = useState(false)

  const handleGenerate = () => {
    if (!dateFrom || !dateTo) {
      toast.error('Please select both dates')
      return
    }
    if (new Date(dateTo) < new Date(dateFrom)) {
      toast.error('End date must be after start date')
      return
    }
    setFilterApplied(true)
    toast.success('Report generated for ' + dateFrom + ' to ' + dateTo)
  }

  const exportCurrentTab = () => {
    let exportData = []
    let filename = `Report_${dateFrom}_to_${dateTo}`

    if (tab === 'sales') {
      exportData = SALES_INVOICES.map(i => ({
        'Invoice #': i.number,
        'Date': i.date,
        'Customer': i.customerName,
        'Branch': i.branchName,
        'Cashier': i.cashier,
        'Taxable (₹)': i.subtotal,
        'GST (₹)': i.taxTotal,
        'Discount (₹)': i.discount,
        'Total (₹)': i.total,
        'Mode': i.paymentMode.toUpperCase(),
        'Status': i.status.toUpperCase(),
      }))
      filename = `Sales_Register_${dateFrom}_to_${dateTo}.csv`
    } else if (tab === 'purchase') {
      exportData = PURCHASE_BILLS.map(b => ({
        'Bill #': b.number,
        'Date': b.date,
        'Vendor': b.vendorName,
        'Branch': b.branchName,
        'Subtotal (₹)': b.subtotal,
        'GST Paid (₹)': b.taxTotal,
        'Total (₹)': b.total,
        'Paid (₹)': b.paidAmount,
        'Status': b.status.toUpperCase(),
      }))
      filename = `Purchase_Register_${dateFrom}_to_${dateTo}.csv`
    } else if (tab === 'tax') {
      exportData = [
        ...TAX_OUTPUT.map(r => ({
          'Type': 'Output (Sales)',
          'GST Rate': r.rate,
          'Taxable': r.taxable,
          'CGST/IGST': r.cgst,
          'SGST': r.sgst,
          'Total Tax': r.cgst + r.sgst,
        })),
        ...TAX_INPUT.map(r => ({
          'Type': 'Input (Purchases)',
          'GST Rate': r.rate,
          'Taxable': r.taxable,
          'CGST/IGST': r.cgst,
          'SGST': r.sgst,
          'Total ITC': r.cgst + r.sgst,
        }))
      ]
      filename = `GST_Summary_${dateFrom}_to_${dateTo}.csv`
    } else if (tab === 'stock') {
      exportData = PRODUCTS.map(p => {
        const open  = (p.stock['br-001']||0) + Math.floor(Math.random()*80+20)
        const pur   = Math.floor(Math.random()*60+10)
        const sold  = Math.floor(Math.random()*50+10)
        const trans = Math.floor(Math.random()*10-5)
        const adj   = Math.floor(Math.random()*4-2)
        const close = open+pur-sold+trans+adj
        return {
          'Item': p.name,
          'SKU': p.sku,
          'Opening Stock': open,
          'Purchased': pur,
          'Sold': sold,
          'Transferred': trans,
          'Adjusted': adj,
          'Closing Stock': close,
        }
      })
      filename = `Stock_Movement_${dateFrom}_to_${dateTo}.csv`
    }

    if (exportData.length > 0) {
      exportToCSV(exportData, filename)
      toast.success(`${tab.charAt(0).toUpperCase() + tab.slice(1)} report exported`)
    } else {
      toast.error('No data to export for this report')
    }
  }

  return (
    <div className="page-container">
      <SectionHeader title="Reports & Analytics" subtitle="Operational and tax-supporting reports for manual filing">
        <input type="date" className="form-input" style={{width:140}} value={dateFrom} onChange={e=>setFrom(e.target.value)} />
        <span style={{color:'var(--text-muted)',fontSize:13}}>to</span>
        <input type="date" className="form-input" style={{width:140}} value={dateTo} onChange={e=>setTo(e.target.value)} />
        <select className="form-input" style={{width:150}} value={branchF} onChange={e=>setBranch(e.target.value)}>
          <option value="">All Branches</option>
          {BRANCHES.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" onClick={handleGenerate}>▶ Generate</button>
        <button className="btn btn-secondary btn-sm" onClick={exportCurrentTab}>↓ Excel</button>
        <button className="btn btn-secondary btn-sm" onClick={() => toast('PDF export coming soon')}>↓ PDF</button>
      </SectionHeader>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {/* ── SALES REPORT ────────────────────────────────────────── */}
      {tab === 'sales' && (
        <>
          <div className="grid-kpi" style={{marginBottom:20}}>
            <KPICard label="Total Sales (Apr)" value={fmt(1248500)} color="var(--accent)" />
            <KPICard label="Total Transactions" value="1,247" color="var(--blue)" />
            <KPICard label="Avg Ticket Size" value={fmt(1001)} color="var(--teal)" />
            <KPICard label="Returns" value={fmt(12400)} color="var(--red)" />
          </div>

          <div className="grid-2" style={{marginBottom:18}}>
            <Card title="Daily Sales Trend">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={SALES_TREND} margin={{top:5,right:10,left:-10,bottom:0}}>
                  <defs>
                    <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)"/>
                  <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text-muted)'}} tickLine={false} axisLine={false}/>
                  <YAxis tick={{fontSize:10,fill:'var(--text-muted)'}} tickLine={false} axisLine={false} tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`}/>
                  <Tooltip content={<TT/>}/>
                  <Area type="monotone" dataKey="sales" name="Sales" stroke="#6366f1" strokeWidth={2.5} fill="url(#sg)" dot={false}/>
                </AreaChart>
              </ResponsiveContainer>
            </Card>
            <Card title="Sales by Payment Mode">
              <div style={{display:'flex',gap:20,alignItems:'center'}}>
                <PieChart width={140} height={140}>
                  <Pie data={[{name:'Cash',value:42},{name:'UPI',value:35},{name:'Card',value:15},{name:'Credit',value:8}]} cx={65} cy={65} innerRadius={40} outerRadius={65} paddingAngle={3} dataKey="value">
                    {['#6366f1','#2dd4bf','#a78bfa','#f5a623'].map((c,i)=><Cell key={i} fill={c}/>)}
                  </Pie>
                </PieChart>
                <BarList items={[
                  {label:'Cash',   value:42, color:'#6366f1'},
                  {label:'UPI',    value:35, color:'#2dd4bf'},
                  {label:'Card',   value:15, color:'#a78bfa'},
                  {label:'Credit', value:8,  color:'#f5a623'},
                ]} valueFormatter={v=>`${v}%`} />
              </div>
            </Card>
          </div>

          <Card title={`Sales Register — ${dateFrom} to ${dateTo}`} titleRight={<button className="btn btn-secondary btn-sm" onClick={() => {
            const exportData = SALES_INVOICES.map(i => ({
              'Invoice #': i.number,
              'Date': i.date,
              'Customer': i.customerName,
              'Branch': i.branchName,
              'Cashier': i.cashier,
              'Taxable (₹)': i.subtotal,
              'GST (₹)': i.taxTotal,
              'Discount (₹)': i.discount,
              'Total (₹)': i.total,
              'Mode': i.paymentMode.toUpperCase(),
              'Status': i.status.toUpperCase(),
            }))
            exportToCSV(exportData, `Sales_Register_${dateFrom}_to_${dateTo}.csv`)
            toast.success('Sales register exported')
          }}>↓ Export</button>} bodyPadding={false}>
            <table className="data-table">
              <thead><tr><th>Invoice #</th><th>Date</th><th>Customer</th><th>Branch</th><th>Cashier</th><th className="text-right">Taxable</th><th className="text-right">GST</th><th className="text-right">Discount</th><th className="text-right">Total</th><th>Mode</th><th>Status</th></tr></thead>
              <tbody>
                {SALES_INVOICES.map(i=>(
                  <tr key={i.id}>
                    <td className="mono" style={{fontSize:11.5,color:'var(--accent)'}}>{i.number}</td>
                    <td style={{fontSize:11.5,color:'var(--text-muted)'}}>{i.date}</td>
                    <td style={{fontSize:12.5,fontWeight:500,color:'var(--text-primary)'}}>{i.customerName}</td>
                    <td style={{fontSize:11.5}}>{i.branchName}</td>
                    <td style={{fontSize:11.5,color:'var(--text-muted)'}}>{i.cashier}</td>
                    <td className="text-right mono">{fmt(i.subtotal)}</td>
                    <td className="text-right mono">{fmt(i.taxTotal)}</td>
                    <td className="text-right mono" style={{color:'var(--green)'}}>{i.discount>0?fmt(i.discount):'—'}</td>
                    <td className="text-right mono" style={{fontWeight:600}}>{fmt(i.total)}</td>
                    <td><span style={{fontSize:11,padding:'2px 7px',borderRadius:5,background:'var(--bg-hover)',color:'var(--text-muted)'}}>{i.paymentMode.toUpperCase()}</span></td>
                    <td><Chip status={i.status}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {/* ── PURCHASE REPORT ─────────────────────────────────────── */}
      {tab === 'purchase' && (
        <>
          <div className="grid-kpi" style={{marginBottom:20}}>
            <KPICard label="Total Purchases (Apr)" value={fmt(842600)} color="var(--purple)" />
            <KPICard label="Vendors Used"           value="6"           color="var(--blue)" />
            <KPICard label="Pending Payments"       value={fmt(118400)} color="var(--amber)" />
            <KPICard label="Overdue Bills"          value="2"           color="var(--red)" />
          </div>
          <Card title={`Purchase Register — ${dateFrom} to ${dateTo}`} titleRight={<button className="btn btn-secondary btn-sm" onClick={() => {
            const exportData = PURCHASE_BILLS.map(b => ({
              'Bill #': b.number,
              'Date': b.date,
              'Vendor': b.vendorName,
              'Branch': b.branchName,
              'Subtotal (₹)': b.subtotal,
              'GST Paid (₹)': b.taxTotal,
              'Total (₹)': b.total,
              'Paid (₹)': b.paidAmount,
              'Status': b.status.toUpperCase(),
            }))
            exportToCSV(exportData, `Purchase_Register_${dateFrom}_to_${dateTo}.csv`)
            toast.success('Purchase register exported')
          }}>↓ Export</button>} bodyPadding={false}>
            <table className="data-table">
              <thead><tr><th>Bill #</th><th>Date</th><th>Vendor</th><th>Branch</th><th className="text-right">Subtotal</th><th className="text-right">GST Paid</th><th className="text-right">Total</th><th className="text-right">Paid</th><th>Status</th></tr></thead>
              <tbody>
                {PURCHASE_BILLS.map(b=>(
                  <tr key={b.id}>
                    <td className="mono" style={{fontSize:11.5,color:'var(--purple)'}}>{b.number}</td>
                    <td style={{fontSize:11.5,color:'var(--text-muted)'}}>{b.date}</td>
                    <td style={{fontSize:12.5,fontWeight:500,color:'var(--text-primary)'}}>{b.vendorName}</td>
                    <td style={{fontSize:11.5}}>{b.branchName}</td>
                    <td className="text-right mono">{fmt(b.subtotal)}</td>
                    <td className="text-right mono">{fmt(b.taxTotal)}</td>
                    <td className="text-right mono" style={{fontWeight:600}}>{fmt(b.total)}</td>
                    <td className="text-right mono" style={{color:b.paidAmount>=b.total?'var(--green)':'var(--amber)'}}>{fmt(b.paidAmount)}</td>
                    <td><Chip status={b.status}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {/* ── TAX SUMMARY ─────────────────────────────────────────── */}
      {tab === 'tax' && (
        <>
          <AlertBar type="blue" icon="ℹ" style={{marginBottom:18}}>
            This GST summary is for manual filing reference only. Share with your CA/Auditor. RetailOS does not file returns automatically.
          </AlertBar>
          <div className="grid-2" style={{marginBottom:18}}>
            <Card title={`GST Output Tax — Sales (${dateFrom} to ${dateTo})`} bodyPadding={false}>
              <table className="data-table">
                <thead><tr><th>GST Rate</th><th className="text-right">Taxable Sales</th><th className="text-right">CGST</th><th className="text-right">SGST</th><th className="text-right">Total GST</th></tr></thead>
                <tbody>
                  {TAX_OUTPUT.map(r=>(
                    <tr key={r.rate}>
                      <td style={{fontWeight:500}}>{r.rate}</td>
                      <td className="text-right mono">{fmt(r.taxable)}</td>
                      <td className="text-right mono">{r.cgst?fmt(r.cgst):'—'}</td>
                      <td className="text-right mono">{r.sgst?fmt(r.sgst):'—'}</td>
                      <td className="text-right mono">{fmt(r.cgst+r.sgst)}</td>
                    </tr>
                  ))}
                  <tr style={{background:'var(--bg-raised)',fontWeight:700}}>
                    <td>Total</td>
                    <td className="text-right mono">{fmt(TAX_OUTPUT.reduce((s,r)=>s+r.taxable,0))}</td>
                    <td className="text-right mono" style={{color:'var(--accent)'}}>{fmt(TAX_OUTPUT.reduce((s,r)=>s+r.cgst,0))}</td>
                    <td className="text-right mono" style={{color:'var(--accent)'}}>{fmt(TAX_OUTPUT.reduce((s,r)=>s+r.sgst,0))}</td>
                    <td className="text-right mono" style={{color:'var(--accent)'}}>{fmt(TAX_OUTPUT.reduce((s,r)=>s+r.cgst+r.sgst,0))}</td>
                  </tr>
                </tbody>
              </table>
            </Card>
            <Card title={`GST Input Tax Credit — Purchases (${dateFrom} to ${dateTo})`} bodyPadding={false}>
              <table className="data-table">
                <thead><tr><th>GST Rate</th><th className="text-right">Taxable Purchase</th><th className="text-right">CGST Paid</th><th className="text-right">SGST Paid</th><th className="text-right">ITC Available</th></tr></thead>
                <tbody>
                  {TAX_INPUT.map(r=>(
                    <tr key={r.rate}>
                      <td style={{fontWeight:500}}>{r.rate}</td>
                      <td className="text-right mono">{fmt(r.taxable)}</td>
                      <td className="text-right mono">{r.cgst?fmt(r.cgst):'—'}</td>
                      <td className="text-right mono">{r.sgst?fmt(r.sgst):'—'}</td>
                      <td className="text-right mono" style={{color:'var(--green)'}}>{fmt(r.cgst+r.sgst)}</td>
                    </tr>
                  ))}
                  <tr style={{background:'var(--bg-raised)',fontWeight:700}}>
                    <td>Total</td>
                    <td className="text-right mono">{fmt(TAX_INPUT.reduce((s,r)=>s+r.taxable,0))}</td>
                    <td className="text-right mono" style={{color:'var(--green)'}}>{fmt(TAX_INPUT.reduce((s,r)=>s+r.cgst,0))}</td>
                    <td className="text-right mono" style={{color:'var(--green)'}}>{fmt(TAX_INPUT.reduce((s,r)=>s+r.sgst,0))}</td>
                    <td className="text-right mono" style={{color:'var(--green)'}}>{fmt(TAX_INPUT.reduce((s,r)=>s+r.cgst+r.sgst,0))}</td>
                  </tr>
                </tbody>
              </table>
            </Card>
          </div>
          <Card title={`Net GST Payable Summary — ${dateFrom} to ${dateTo}`}>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
              {[
                {label:'Output GST (from Sales)',  value:fmt(122880), color:'var(--red)',    sub:'Total collected from customers'},
                {label:'Input Tax Credit (ITC)',   value:fmt(63840),  color:'var(--green)',  sub:'GST paid on purchases (claimable)'},
                {label:'Net GST Payable',          value:fmt(59040),  color:'var(--accent)', sub:'Output − ITC = Payable to Government'},
              ].map(c=>(
                <div key={c.label} style={{padding:'18px 20px',background:'var(--bg-raised)',borderRadius:12,textAlign:'center'}}>
                  <div style={{fontSize:11.5,color:'var(--text-muted)',marginBottom:8}}>{c.label}</div>
                  <div style={{fontSize:26,fontWeight:700,fontFamily:'DM Mono,monospace',color:c.color,marginBottom:6}}>{c.value}</div>
                  <div style={{fontSize:11.5,color:'var(--text-muted)'}}>{c.sub}</div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {/* ── STOCK MOVEMENT ──────────────────────────────────────── */}
      {tab === 'stock' && (
        <Card title={`Stock Movement Report — ${dateFrom} to ${dateTo}`} titleRight={<button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = PRODUCTS.map(p => {
            const open  = (p.stock['br-001']||0) + Math.floor(Math.random()*80+20)
            const pur   = Math.floor(Math.random()*60+10)
            const sold  = Math.floor(Math.random()*50+10)
            const trans = Math.floor(Math.random()*10-5)
            const adj   = Math.floor(Math.random()*4-2)
            const close = open+pur-sold+trans+adj
            return {
              'Item': p.name,
              'SKU': p.sku,
              'Opening Stock': open,
              'Purchased': pur,
              'Sold': sold,
              'Transferred': trans,
              'Adjusted': adj,
              'Closing Stock': close,
            }
          })
          exportToCSV(exportData, `Stock_Movement_${dateFrom}_to_${dateTo}.csv`)
          toast.success('Stock movement report exported')
        }}>↓ Export</button>} bodyPadding={false}>
          <table className="data-table">
            <thead><tr><th>Item</th><th className="text-right">Opening</th><th className="text-right">Purchased</th><th className="text-right">Sold</th><th className="text-right">Transferred</th><th className="text-right">Adjusted</th><th className="text-right">Closing</th><th>Variance</th></tr></thead>
            <tbody>
              {PRODUCTS.map(p=>{
                const open  = (p.stock['br-001']||0) + Math.floor(Math.random()*80+20)
                const pur   = Math.floor(Math.random()*60+10)
                const sold  = Math.floor(Math.random()*50+10)
                const trans = Math.floor(Math.random()*10-5)
                const adj   = Math.floor(Math.random()*4-2)
                const close = open+pur-sold+trans+adj
                const expected = open+pur-sold+trans
                const variance = close-expected
                return (
                  <tr key={p.id}>
                    <td><div style={{display:'flex',alignItems:'center',gap:8}}><span style={{fontSize:18}}>{p.emoji}</span><div><div style={{fontWeight:500,color:'var(--text-primary)',fontSize:12.5}}>{p.name}</div><div style={{fontSize:11,color:'var(--text-muted)'}}>{p.sku}</div></div></div></td>
                    <td className="text-right mono">{open}</td>
                    <td className="text-right mono" style={{color:'var(--green)'}}>+{pur}</td>
                    <td className="text-right mono" style={{color:'var(--red)'}}>-{sold}</td>
                    <td className="text-right mono" style={{color:'var(--blue)'}}>{trans>=0?'+':''}{trans}</td>
                    <td className="text-right mono">{adj>=0?'+':''}{adj}</td>
                    <td className="text-right mono" style={{fontWeight:600,color:'var(--text-primary)'}}>{close}</td>
                    <td><span style={{fontSize:11.5,padding:'2px 8px',borderRadius:10,background:variance===0?'var(--green-bg)':variance>0?'var(--blue-bg)':'var(--red-bg)',color:variance===0?'var(--green)':variance>0?'var(--blue)':'var(--red)',fontWeight:600}}>{variance===0?'Match':variance>0?'+'+variance:variance}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── BRANCH COMPARISON ───────────────────────────────────── */}
      {tab === 'branch' && (
        <>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:20}}>
            {[
              {name:'Anna Nagar', sales:1480000, purchases:840000, cashiers:4, color:'#6366f1'},
              {name:'T. Nagar',   sales:1120000, purchases:620000, cashiers:3, color:'#a78bfa'},
              {name:'Vadapalani', sales:860000,  purchases:480000, cashiers:2, color:'#2dd4bf'},
              {name:'Velachery',  sales:540000,  purchases:310000, cashiers:2, color:'#f5a623'},
            ].map(b=>(
              <div key={b.name} style={{background:'var(--bg-surface)',border:'1px solid var(--border-default)',borderRadius:14,padding:18}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
                  <span style={{width:10,height:10,borderRadius:'50%',background:b.color,display:'inline-block'}}/>
                  <span style={{fontWeight:600,fontSize:14}}>{b.name}</span>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
                  <div><div style={{fontSize:11,color:'var(--text-muted)'}}>Sales (Apr)</div><div style={{fontSize:16,fontWeight:700,color:'var(--text-primary)'}}>{fmt(b.sales)}</div></div>
                  <div><div style={{fontSize:11,color:'var(--text-muted)'}}>Purchases</div><div style={{fontSize:15,fontWeight:600,color:'var(--text-secondary)'}}>{fmt(b.purchases)}</div></div>
                </div>
                <div style={{fontSize:11,color:'var(--text-muted)',marginBottom:4}}>Performance vs Anna Nagar</div>
                <div style={{height:6,background:'var(--bg-hover)',borderRadius:3,overflow:'hidden'}}>
                  <div style={{height:'100%',borderRadius:3,background:b.color,width:`${Math.round(b.sales/14800)}%`,transition:'width 1s ease'}}/>
                </div>
              </div>
            ))}
          </div>
          <Card title="Branch Sales Comparison Chart">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={SALES_TREND.slice(-7).map(d=>({...d,tnagar:Math.round(d.sales*0.76),vadapalani:Math.round(d.sales*0.55),velachery:Math.round(d.sales*0.35)}))} margin={{top:5,right:10,left:-10,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)"/>
                <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text-muted)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:10,fill:'var(--text-muted)'}} tickLine={false} axisLine={false} tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`}/>
                <Tooltip content={<TT/>}/>
                <Legend wrapperStyle={{fontSize:11,color:'var(--text-muted)'}}/>
                <Bar dataKey="sales"     name="Anna Nagar" fill="#6366f1" radius={[3,3,0,0]}/>
                <Bar dataKey="tnagar"    name="T. Nagar"   fill="#a78bfa" radius={[3,3,0,0]}/>
                <Bar dataKey="vadapalani" name="Vadapalani" fill="#2dd4bf" radius={[3,3,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}

      {/* ── MARGIN ANALYSIS ─────────────────────────────────────── */}
      {tab === 'margin' && (
        <>
          <div className="grid-kpi" style={{marginBottom:20}}>
            <KPICard label="Avg Gross Margin"  value="23.4%"    color="var(--green)"  />
            <KPICard label="Highest Margin"    value="Parle-G"  color="var(--teal)"   sub="28.4% margin" />
            <KPICard label="Lowest Margin"     value="Milk 1L"  color="var(--amber)"  sub="8.8% margin" />
            <KPICard label="Margin on Revenue" value={fmt(292000)} color="var(--accent)" />
          </div>
          <div className="grid-2">
            <Card title="Margin by Product">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={MARGIN_DATA} layout="vertical" margin={{top:0,right:40,left:10,bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" horizontal={false}/>
                  <XAxis type="number" tick={{fontSize:10,fill:'var(--text-muted)'}} tickLine={false} axisLine={false} tickFormatter={v=>`${v}%`}/>
                  <YAxis type="category" dataKey="name" tick={{fontSize:10.5,fill:'var(--text-secondary)'}} tickLine={false} axisLine={false} width={90}/>
                  <Tooltip formatter={v=>`${v}%`}/>
                  <Bar dataKey="margin" name="Margin %" fill="#22c97a" radius={[0,4,4,0]}>
                    {MARGIN_DATA.map((_,i)=><Cell key={i} fill={MARGIN_DATA[i].margin>20?'#22c97a':MARGIN_DATA[i].margin>15?'#f5a623':'#f5485c'}/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
            <Card title="Sales by Category">
              <div style={{display:'flex',alignItems:'center',gap:20}}>
                <PieChart width={160} height={160}>
                  <Pie data={CAT_DATA} cx={75} cy={75} innerRadius={45} outerRadius={75} paddingAngle={3} dataKey="value">
                    {CAT_DATA.map((_,i)=><Cell key={i} fill={CAT_DATA[i].color}/>)}
                  </Pie>
                </PieChart>
                <div style={{flex:1}}>
                  {CAT_DATA.map(c=>(
                    <div key={c.name} style={{display:'flex',alignItems:'center',gap:8,marginBottom:8,fontSize:12.5}}>
                      <span style={{width:10,height:10,borderRadius:'50%',background:c.color,flexShrink:0}}/>
                      <span style={{flex:1,color:'var(--text-secondary)'}}>{c.name}</span>
                      <span style={{fontWeight:600,color:'var(--text-primary)'}}>{c.value}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
