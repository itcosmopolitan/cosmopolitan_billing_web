// ─── SEED DATA ───────────────────────────────────────────────────────────────
// Frontend-side fallback / demo data, used by pages that haven't been wired
// to the backend yet (Dashboard, Reports — see Tier 3 of the audit) and by
// POSPage as an offline fallback when the backend is unreachable.
//
// Branches were intentionally removed from this file: the canonical branch
// list lives on the server (`/branches`) and is hydrated into useAppStore at
// boot. Consume `useAppStore.branches` instead.

export const CATEGORIES = [
  { id: 'cat-001', name: 'Grains & Pulses', icon: '🌾' },
  { id: 'cat-002', name: 'Oils & Ghee', icon: '🫙' },
  { id: 'cat-003', name: 'Dairy & Eggs', icon: '🥛' },
  { id: 'cat-004', name: 'Snacks & Biscuits', icon: '🍪' },
  { id: 'cat-005', name: 'Beverages', icon: '☕' },
  { id: 'cat-006', name: 'Household', icon: '🧴' },
  { id: 'cat-007', name: 'Personal Care', icon: '🪥' },
  { id: 'cat-008', name: 'Frozen & Chilled', icon: '❄️' },
]

export const PRODUCTS = [
  { id: 'pr-001', name: 'Basmati Rice 5kg', sku: 'GR-001', barcode: '8901234560001', catId: 'cat-001', category: 'Grains & Pulses', brand: 'India Gate', unit: 'Pack', costPrice: 240, sellingPrice: 299, taxRate: 0, hsnCode: '1006', reorderLevel: 50, emoji: '🌾', stock: { 'br-001': 145, 'br-002': 62, 'br-003': 38, 'br-004': 24, 'br-005': 320 }, active: true },
  { id: 'pr-002', name: 'Toor Dal 1kg', sku: 'GR-002', barcode: '8901234560002', catId: 'cat-001', category: 'Grains & Pulses', brand: 'Tata Sampann', unit: 'Pack', costPrice: 120, sellingPrice: 148, taxRate: 5, hsnCode: '0713', reorderLevel: 60, emoji: '🫘', stock: { 'br-001': 220, 'br-002': 145, 'br-003': 88, 'br-004': 66, 'br-005': 480 }, active: true },
  { id: 'pr-003', name: 'Sunflower Oil 1L', sku: 'OIL-001', barcode: '8901234560003', catId: 'cat-002', category: 'Oils & Ghee', brand: 'Fortune', unit: 'Bottle', costPrice: 118, sellingPrice: 148, taxRate: 5, hsnCode: '1512', reorderLevel: 40, emoji: '🫙', stock: { 'br-001': 88, 'br-002': 56, 'br-003': 34, 'br-004': 12, 'br-005': 240 }, active: true },
  { id: 'pr-004', name: 'Parle-G 800g', sku: 'SN-001', barcode: '8901234560004', catId: 'cat-004', category: 'Snacks & Biscuits', brand: 'Parle', unit: 'Pack', costPrice: 38, sellingPrice: 50, taxRate: 18, hsnCode: '1905', reorderLevel: 80, emoji: '🍪', stock: { 'br-001': 340, 'br-002': 280, 'br-003': 190, 'br-004': 120, 'br-005': 600 }, active: true },
  { id: 'pr-005', name: 'Amul Butter 500g', sku: 'DY-001', barcode: '8901234560005', catId: 'cat-003', category: 'Dairy & Eggs', brand: 'Amul', unit: 'Pack', costPrice: 118, sellingPrice: 150, taxRate: 12, hsnCode: '0405', reorderLevel: 30, emoji: '🧈', stock: { 'br-001': 62, 'br-002': 44, 'br-003': 28, 'br-004': 18, 'br-005': 120 }, active: true },
  { id: 'pr-006', name: 'Aashirvaad Atta 5kg', sku: 'GR-003', barcode: '8901234560006', catId: 'cat-001', category: 'Grains & Pulses', brand: 'ITC', unit: 'Pack', costPrice: 195, sellingPrice: 240, taxRate: 0, hsnCode: '1101', reorderLevel: 40, emoji: '🌾', stock: { 'br-001': 92, 'br-002': 68, 'br-003': 44, 'br-004': 30, 'br-005': 280 }, active: true },
  { id: 'pr-007', name: 'Maggi Noodles 12pk', sku: 'SN-002', barcode: '8901234560007', catId: 'cat-004', category: 'Snacks & Biscuits', brand: 'Nestlé', unit: 'Pack', costPrice: 150, sellingPrice: 192, taxRate: 18, hsnCode: '1902', reorderLevel: 50, emoji: '🍜', stock: { 'br-001': 160, 'br-002': 110, 'br-003': 72, 'br-004': 44, 'br-005': 360 }, active: true },
  { id: 'pr-008', name: 'Surf Excel 1kg', sku: 'HH-001', barcode: '8901234560008', catId: 'cat-006', category: 'Household', brand: 'HUL', unit: 'Pack', costPrice: 128, sellingPrice: 160, taxRate: 18, hsnCode: '3402', reorderLevel: 25, emoji: '🧼', stock: { 'br-001': 8, 'br-002': 14, 'br-003': 5, 'br-004': 22, 'br-005': 180 }, active: true },
  { id: 'pr-009', name: 'Haldiram Bhujia 200g', sku: 'SN-003', barcode: '8901234560009', catId: 'cat-004', category: 'Snacks & Biscuits', brand: 'Haldiram', unit: 'Pack', costPrice: 44, sellingPrice: 60, taxRate: 18, hsnCode: '2106', reorderLevel: 60, emoji: '🥜', stock: { 'br-001': 280, 'br-002': 210, 'br-003': 140, 'br-004': 95, 'br-005': 500 }, active: true },
  { id: 'pr-010', name: 'Coconut Oil 500ml', sku: 'OIL-002', barcode: '8901234560010', catId: 'cat-002', category: 'Oils & Ghee', brand: 'Parachute', unit: 'Bottle', costPrice: 142, sellingPrice: 180, taxRate: 5, hsnCode: '1513', reorderLevel: 30, emoji: '🥥', stock: { 'br-001': 12, 'br-002': 28, 'br-003': 40, 'br-004': 18, 'br-005': 200 }, active: true },
  { id: 'pr-011', name: 'Horlicks 500g', sku: 'BV-001', barcode: '8901234560011', catId: 'cat-005', category: 'Beverages', brand: 'GlaxoSmithKline', unit: 'Jar', costPrice: 218, sellingPrice: 280, taxRate: 18, hsnCode: '2202', reorderLevel: 20, emoji: '🥛', stock: { 'br-001': 45, 'br-002': 30, 'br-003': 18, 'br-004': 24, 'br-005': 120 }, active: true },
  { id: 'pr-012', name: 'Dettol Soap 4pk', sku: 'PC-001', barcode: '8901234560012', catId: 'cat-007', category: 'Personal Care', brand: 'Reckitt', unit: 'Pack', costPrice: 95, sellingPrice: 120, taxRate: 18, hsnCode: '3401', reorderLevel: 30, emoji: '🧴', stock: { 'br-001': 95, 'br-002': 74, 'br-003': 48, 'br-004': 36, 'br-005': 240 }, active: true },
  { id: 'pr-013', name: 'Amul Milk 1L Packet', sku: 'DY-002', barcode: '8901234560013', catId: 'cat-003', category: 'Dairy & Eggs', brand: 'Amul', unit: 'Litre', costPrice: 56, sellingPrice: 68, taxRate: 0, hsnCode: '0401', reorderLevel: 100, emoji: '🥛', stock: { 'br-001': 180, 'br-002': 140, 'br-003': 90, 'br-004': 70, 'br-005': 400 }, active: true },
  { id: 'pr-014', name: 'Colgate MaxFresh 150g', sku: 'PC-002', barcode: '8901234560014', catId: 'cat-007', category: 'Personal Care', brand: 'Colgate', unit: 'Tube', costPrice: 72, sellingPrice: 92, taxRate: 18, hsnCode: '3306', reorderLevel: 40, emoji: '🦷', stock: { 'br-001': 64, 'br-002': 48, 'br-003': 32, 'br-004': 44, 'br-005': 200 }, active: true },
  { id: 'pr-015', name: 'Nescafé Classic 50g', sku: 'BV-002', barcode: '8901234560015', catId: 'cat-005', category: 'Beverages', brand: 'Nestlé', unit: 'Jar', costPrice: 148, sellingPrice: 188, taxRate: 18, hsnCode: '2101', reorderLevel: 20, emoji: '☕', stock: { 'br-001': 38, 'br-002': 26, 'br-003': 16, 'br-004': 20, 'br-005': 140 }, active: true },
  { id: 'pr-016', name: 'Chana Dal 1kg', sku: 'GR-004', barcode: '8901234560016', catId: 'cat-001', category: 'Grains & Pulses', brand: 'Local', unit: 'Pack', costPrice: 88, sellingPrice: 110, taxRate: 5, hsnCode: '0713', reorderLevel: 40, emoji: '🫘', stock: { 'br-001': 4, 'br-002': 8, 'br-003': 2, 'br-004': 6, 'br-005': 350 }, active: true },
]

export const CUSTOMERS = [
  { id: 'cu-001', name: 'Priya Sharma', phone: '9876543210', email: 'priya@email.com', address: 'Flat 4B, Anna Nagar', gstIn: '', branchId: 'br-001', creditLimit: 20000, outstanding: 0, totalPurchases: 482000, type: 'retail', active: true },
  { id: 'cu-002', name: 'Rajesh Stores', phone: '9445566712', email: 'rajesh@stores.com', address: '28, Pondy Bazar, T.Nagar', gstIn: '33ABCDE1234F1Z5', branchId: 'br-002', creditLimit: 100000, outstanding: 38400, totalPurchases: 1864000, type: 'wholesale', active: true },
  { id: 'cu-003', name: 'Meena Krishnan', phone: '8776623411', email: 'meena@email.com', address: 'Velachery Main Road', gstIn: '', branchId: 'br-004', creditLimit: 10000, outstanding: 6200, totalPurchases: 112400, type: 'retail', active: true },
  { id: 'cu-004', name: 'Anand Traders', phone: '9810044512', email: 'anand@traders.in', address: '5, Industrial Estate, Guindy', gstIn: '33XYZAB5678G1Z3', branchId: 'br-001', creditLimit: 200000, outstanding: 84200, totalPurchases: 4280000, type: 'wholesale', active: true },
  { id: 'cu-005', name: 'Subramanian V.', phone: '9500011234', email: '', address: 'Vadapalani', gstIn: '', branchId: 'br-003', creditLimit: 5000, outstanding: 0, totalPurchases: 48200, type: 'retail', active: true },
  { id: 'cu-006', name: 'Krishnan Stores', phone: '9444455123', email: 'krishnan@email.com', address: 'Usman Road, T.Nagar', gstIn: '33PQRST9876H1Z1', branchId: 'br-002', creditLimit: 50000, outstanding: 6200, totalPurchases: 680000, type: 'wholesale', active: false },
]

export const VENDORS = [
  { id: 'vn-001', name: 'Sri Krishna Traders', contactPerson: 'Krishnamurthy', phone: '9444401234', email: 'skrish@gmail.com', address: 'Koyambedu Market', gstIn: '33ABCDE0001A1Z1', paymentTerms: '30 days', outstanding: 0, totalPurchases: 2840000 },
  { id: 'vn-002', name: 'Madurai Provisions Co.', contactPerson: 'Rajan', phone: '9842201234', email: '', address: 'Madurai', gstIn: '33FGHIJ0002B1Z1', paymentTerms: '15 days', outstanding: 14200, totalPurchases: 1240000 },
  { id: 'vn-003', name: 'Chennai Oils Ltd', contactPerson: 'Sundar', phone: '9500012345', email: 'coi@oils.in', address: 'Arumbakkam', gstIn: '33KLMNO0003C1Z1', paymentTerms: 'Advance', outstanding: 18600, totalPurchases: 860000 },
  { id: 'vn-004', name: 'Tamil Nadu Agri Corp', contactPerson: 'Senthil', phone: '9445512345', email: '', address: 'Kancheepuram', gstIn: '33PQRST0004D1Z1', paymentTerms: '45 days', outstanding: 0, totalPurchases: 3620000 },
  { id: 'vn-005', name: 'Parle Distributor TN', contactPerson: 'Babu', phone: '9345512345', email: 'parle.tn@gmail.com', address: 'Guindy', gstIn: '33UVWXY0005E1Z1', paymentTerms: '30 days', outstanding: 12400, totalPurchases: 640000 },
  { id: 'vn-006', name: 'Amul Milk Depot', contactPerson: 'Rajaram', phone: '9876500001', email: 'amul.chn@amul.com', address: 'Perungudi', gstIn: '33ABCDE1111F1Z1', paymentTerms: 'Weekly', outstanding: 0, totalPurchases: 1120000 },
]

export const SALES_INVOICES = [
  { id: 'inv-001', number: 'INV-2024-1847', customerId: 'cu-002', customerName: 'Rajesh Stores', branchId: 'br-001', branchName: 'Anna Nagar', cashier: 'Arjun M.', date: '2024-04-16', items: [{ productId: 'pr-001', name: 'Basmati Rice 5kg', qty: 20, price: 299, taxRate: 0, lineTotal: 5980 }, { productId: 'pr-002', name: 'Toor Dal 1kg', qty: 30, price: 148, taxRate: 5, lineTotal: 4440 }], subtotal: 10420, taxTotal: 222, discount: 0, total: 10642, paidAmount: 10642, paymentMode: 'upi', status: 'paid', notes: '' },
  { id: 'inv-002', number: 'INV-2024-1846', customerId: null, customerName: 'Walk-in', branchId: 'br-001', branchName: 'Anna Nagar', cashier: 'Arjun M.', date: '2024-04-16', items: [{ productId: 'pr-004', name: 'Parle-G 800g', qty: 5, price: 50, taxRate: 18, lineTotal: 250 }, { productId: 'pr-009', name: 'Haldiram Bhujia 200g', qty: 3, price: 60, taxRate: 18, lineTotal: 180 }], subtotal: 430, taxTotal: 77.4, discount: 0, total: 507, paidAmount: 507, paymentMode: 'cash', status: 'paid', notes: '' },
  { id: 'inv-003', number: 'INV-2024-1845', customerId: 'cu-001', customerName: 'Priya Sharma', branchId: 'br-001', branchName: 'Anna Nagar', cashier: 'Arjun M.', date: '2024-04-16', items: [{ productId: 'pr-005', name: 'Amul Butter 500g', qty: 4, price: 150, taxRate: 12, lineTotal: 600 }, { productId: 'pr-013', name: 'Amul Milk 1L', qty: 10, price: 68, taxRate: 0, lineTotal: 680 }], subtotal: 1280, taxTotal: 72, discount: 0, total: 1352, paidAmount: 1352, paymentMode: 'card', status: 'paid', notes: '' },
  { id: 'inv-004', number: 'INV-2024-1844', customerId: 'cu-004', customerName: 'Anand Traders', branchId: 'br-001', branchName: 'Anna Nagar', cashier: 'Kavitha R.', date: '2024-04-16', items: [{ productId: 'pr-006', name: 'Aashirvaad Atta 5kg', qty: 50, price: 240, taxRate: 0, lineTotal: 12000 }, { productId: 'pr-003', name: 'Sunflower Oil 1L', qty: 40, price: 148, taxRate: 5, lineTotal: 5920 }], subtotal: 17920, taxTotal: 296, discount: 200, total: 18016, paidAmount: 0, paymentMode: 'credit', status: 'pending', notes: 'Net 30 days' },
  { id: 'inv-005', number: 'INV-2024-1843', customerId: null, customerName: 'Walk-in', branchId: 'br-002', branchName: 'T. Nagar', cashier: 'Deepa S.', date: '2024-04-16', items: [{ productId: 'pr-007', name: 'Maggi Noodles 12pk', qty: 4, price: 192, taxRate: 18, lineTotal: 768 }], subtotal: 768, taxTotal: 138.24, discount: 0, total: 906, paidAmount: 906, paymentMode: 'cash', status: 'paid', notes: '' },
  { id: 'inv-006', number: 'INV-2024-1842', customerId: 'cu-004', customerName: 'Anand Traders', branchId: 'br-001', branchName: 'Anna Nagar', cashier: 'Arjun M.', date: '2024-04-15', items: [{ productId: 'pr-001', name: 'Basmati Rice 5kg', qty: 100, price: 299, taxRate: 0, lineTotal: 29900 }, { productId: 'pr-002', name: 'Toor Dal 1kg', qty: 100, price: 148, taxRate: 5, lineTotal: 14800 }], subtotal: 44700, taxTotal: 740, discount: 400, total: 45040, paidAmount: 20000, paymentMode: 'partial', status: 'partial', notes: 'Balance Rf25,040 due May 1' },
  { id: 'inv-007', number: 'INV-2024-1840', customerId: 'cu-006', customerName: 'Krishnan Stores', branchId: 'br-002', branchName: 'T. Nagar', cashier: 'Deepa S.', date: '2024-04-04', items: [{ productId: 'pr-004', name: 'Parle-G 800g', qty: 40, price: 50, taxRate: 18, lineTotal: 2000 }, { productId: 'pr-009', name: 'Haldiram Bhujia 200g', qty: 30, price: 60, taxRate: 18, lineTotal: 1800 }], subtotal: 3800, taxTotal: 684, discount: 0, total: 4484, paidAmount: 0, paymentMode: 'credit', status: 'overdue', notes: 'Overdue 12 days' },
]

export const PURCHASE_BILLS = [
  { id: 'pb-001', number: 'PUR-2024-0412', vendorId: 'vn-001', vendorName: 'Sri Krishna Traders', branchId: 'br-001', branchName: 'Anna Nagar', date: '2024-04-16', items: [{ productId: 'pr-001', name: 'Basmati Rice 5kg', qty: 100, cost: 240, taxRate: 0, lineTotal: 24000 }, { productId: 'pr-002', name: 'Toor Dal 1kg', qty: 120, cost: 120, taxRate: 5, lineTotal: 14400 }], subtotal: 38400, taxTotal: 720, discount: 0, total: 39120, paidAmount: 39120, paymentRef: 'NEFT-20240416-001', status: 'paid', dueDate: '2024-05-16' },
  { id: 'pb-002', number: 'PUR-2024-0411', vendorId: 'vn-002', vendorName: 'Madurai Provisions Co.', branchId: 'br-002', branchName: 'T. Nagar', date: '2024-04-15', items: [{ productId: 'pr-006', name: 'Aashirvaad Atta 5kg', qty: 80, cost: 195, taxRate: 0, lineTotal: 15600 }, { productId: 'pr-016', name: 'Chana Dal 1kg', qty: 80, cost: 88, taxRate: 5, lineTotal: 7040 }], subtotal: 22640, taxTotal: 352, discount: 0, total: 22992, paidAmount: 11496, paymentRef: 'CHQ-1001', status: 'partial', dueDate: '2024-04-30' },
  { id: 'pb-003', number: 'PUR-2024-0410', vendorId: 'vn-003', vendorName: 'Chennai Oils Ltd', branchId: 'br-001', branchName: 'Anna Nagar', date: '2024-04-14', items: [{ productId: 'pr-003', name: 'Sunflower Oil 1L', qty: 100, cost: 118, taxRate: 5, lineTotal: 11800 }, { productId: 'pr-010', name: 'Coconut Oil 500ml', qty: 60, cost: 142, taxRate: 5, lineTotal: 8520 }], subtotal: 20320, taxTotal: 1016, discount: 0, total: 21336, paidAmount: 0, paymentRef: '', status: 'pending', dueDate: '2024-04-24' },
  { id: 'pb-004', number: 'PUR-2024-0409', vendorId: 'vn-004', vendorName: 'Tamil Nadu Agri Corp', branchId: 'br-003', branchName: 'Vadapalani', date: '2024-04-13', items: [{ productId: 'pr-001', name: 'Basmati Rice 5kg', qty: 60, cost: 240, taxRate: 0, lineTotal: 14400 }, { productId: 'pr-006', name: 'Aashirvaad Atta 5kg', qty: 40, cost: 195, taxRate: 0, lineTotal: 7800 }], subtotal: 22200, taxTotal: 0, discount: 200, total: 22000, paidAmount: 22000, paymentRef: 'NEFT-20240413-002', status: 'paid', dueDate: '2024-05-28' },
  { id: 'pb-005', number: 'PUR-2024-0408', vendorId: 'vn-005', vendorName: 'Parle Distributor TN', branchId: 'br-001', branchName: 'Anna Nagar', date: '2024-04-12', items: [{ productId: 'pr-004', name: 'Parle-G 800g', qty: 200, cost: 38, taxRate: 18, lineTotal: 7600 }, { productId: 'pr-009', name: 'Haldiram Bhujia 200g', qty: 120, cost: 44, taxRate: 18, lineTotal: 5280 }], subtotal: 12880, taxTotal: 2318, discount: 0, total: 15198, paidAmount: 0, paymentRef: '', status: 'overdue', dueDate: '2024-04-12' },
  { id: 'pb-006', number: 'PUR-2024-0407', vendorId: 'vn-006', vendorName: 'Amul Milk Depot', branchId: 'br-002', branchName: 'T. Nagar', date: '2024-04-11', items: [{ productId: 'pr-013', name: 'Amul Milk 1L', qty: 100, cost: 56, taxRate: 0, lineTotal: 5600 }, { productId: 'pr-005', name: 'Amul Butter 500g', qty: 20, cost: 118, taxRate: 12, lineTotal: 2360 }], subtotal: 7960, taxTotal: 283.2, discount: 0, total: 8243, paidAmount: 8243, paymentRef: 'NEFT-20240411-001', status: 'paid', dueDate: '2024-04-18' },
]

export const STOCK_TRANSFERS = [
  { id: 'tr-001', refNumber: 'TRF-2024-041', fromBranch: 'br-001', fromBranchName: 'Anna Nagar', toBranch: 'br-002', toBranchName: 'T. Nagar', requestedBy: 'Mohan K.', approvedBy: null, items: [{ productId: 'pr-001', name: 'Basmati Rice 5kg', qty: 20 }, { productId: 'pr-002', name: 'Toor Dal 1kg', qty: 15 }, { productId: 'pr-006', name: 'Aashirvaad Atta 5kg', qty: 10 }], status: 'pending', requestDate: '2024-04-16', notes: 'Urgent — low stock at TN' },
  { id: 'tr-002', refNumber: 'TRF-2024-040', fromBranch: 'br-005', fromBranchName: 'Warehouse', toBranch: 'br-004', toBranchName: 'Velachery', requestedBy: 'Anitha M.', approvedBy: 'Suresh Anand', items: [{ productId: 'pr-004', name: 'Parle-G 800g', qty: 80 }, { productId: 'pr-009', name: 'Haldiram Bhujia 200g', qty: 60 }], status: 'received', requestDate: '2024-04-15', notes: '' },
  { id: 'tr-003', refNumber: 'TRF-2024-039', fromBranch: 'br-002', fromBranchName: 'T. Nagar', toBranch: 'br-003', toBranchName: 'Vadapalani', requestedBy: 'Ravi S.', approvedBy: 'Kavitha R.', items: [{ productId: 'pr-003', name: 'Sunflower Oil 1L', qty: 20 }, { productId: 'pr-010', name: 'Coconut Oil 500ml', qty: 15 }], status: 'transit', requestDate: '2024-04-14', notes: '' },
]

export const CASH_ENTRIES = [
  { id: 'ce-001', branchId: 'br-001', type: 'in',  category: 'Opening Balance', description: 'Opening cash balance', amount: 5000,  ref: '', date: '2024-04-16', time: '09:00', by: 'Kavitha R.' },
  { id: 'ce-002', branchId: 'br-001', type: 'in',  category: 'Cash Sale', description: 'POS-2024-1840 cash received', amount: 1240,  ref: 'POS-2024-1840', date: '2024-04-16', time: '10:42', by: 'Arjun M.' },
  { id: 'ce-003', branchId: 'br-001', type: 'out', category: 'Electricity', description: 'TNEB electricity bill payment', amount: 2400,  ref: 'TNEB-APR24', date: '2024-04-16', time: '11:30', by: 'Kavitha R.' },
  { id: 'ce-004', branchId: 'br-001', type: 'in',  category: 'Cash Sale', description: 'POS-2024-1841 cash received', amount: 3480,  ref: 'POS-2024-1841', date: '2024-04-16', time: '12:15', by: 'Arjun M.' },
  { id: 'ce-005', branchId: 'br-001', type: 'out', category: 'Vendor Payment', description: 'Cash payment to rice supplier', amount: 1800,  ref: '', date: '2024-04-16', time: '14:00', by: 'Kavitha R.' },
  { id: 'ce-006', branchId: 'br-001', type: 'out', category: 'Transport', description: 'Auto delivery charge', amount: 360,   ref: '', date: '2024-04-16', time: '15:30', by: 'Arjun M.' },
  { id: 'ce-007', branchId: 'br-001', type: 'in',  category: 'Cash Sale', description: 'Multiple POS transactions batch', amount: 8640,  ref: '', date: '2024-04-16', time: '16:00', by: 'Arjun M.' },
  { id: 'ce-008', branchId: 'br-001', type: 'out', category: 'Stationery', description: 'Receipt paper rolls 10 packs', amount: 200,   ref: '', date: '2024-04-16', time: '16:45', by: 'Arjun M.' },
]

export const USERS = [
  { id: 'usr-001', name: 'Suresh Anand', email: 'suresh@srimurugan.com', role: 'super_admin', branchId: null, branchName: 'All Branches', avatar: 'SA', active: true, lastLogin: '2024-04-16 09:00' },
  { id: 'usr-002', name: 'Kavitha R.', email: 'kavitha@srimurugan.com', role: 'branch_manager', branchId: 'br-001', branchName: 'Anna Nagar', avatar: 'KR', active: true, lastLogin: '2024-04-16 09:05' },
  { id: 'usr-003', name: 'Arjun M.', email: 'arjun@srimurugan.com', role: 'cashier', branchId: 'br-001', branchName: 'Anna Nagar', avatar: 'AM', active: true, lastLogin: '2024-04-16 09:30' },
  { id: 'usr-004', name: 'Deepa S.', email: 'deepa@srimurugan.com', role: 'inventory_manager', branchId: 'br-002', branchName: 'T. Nagar', avatar: 'DS', active: true, lastLogin: '2024-04-16 09:10' },
  { id: 'usr-005', name: 'Prakash V.', email: 'prakash@srimurugan.com', role: 'finance', branchId: null, branchName: 'All Branches', avatar: 'PV', active: false, lastLogin: '2024-04-10 14:00' },
  { id: 'usr-006', name: 'Mohan K.', email: 'mohan@srimurugan.com', role: 'branch_manager', branchId: 'br-002', branchName: 'T. Nagar', avatar: 'MK', active: true, lastLogin: '2024-04-16 09:20' },
]

export const ROLES = {
  super_admin: {
    label: 'Super Admin',
    color: 'purple',
    permissions: ['*'],
    description: 'Full access to all modules and settings'
  },
  branch_manager: {
    label: 'Branch Manager',
    color: 'blue',
    permissions: [
      'dashboard.view', 'dashboard.export',
      'pos.create', 'pos.view', 'pos.edit', 'pos.cancel',
      'sales.create', 'sales.view', 'sales.edit', 'sales.export',
      'purchases.view', 'purchases.edit',
      'inventory.view', 'inventory.edit', 'inventory.adjust', 'inventory.export',
      'transfers.create', 'transfers.approve',
      'customers.view', 'customers.create',
      'vendors.view',
      'cash.view', 'cash.edit',
      'reports.view', 'reports.export'
    ],
    description: 'Manage branch operations, sales, and inventory'
  },
  cashier: {
    label: 'Cashier',
    color: 'teal',
    permissions: [
      'dashboard.view',
      'pos.create', 'pos.view', 'pos.cancel',
      'sales.view',
      'cash.view', 'cash.entry',
      'customers.view'
    ],
    description: 'Process sales and manage cash transactions'
  },
  inventory_manager: {
    label: 'Inventory Manager',
    color: 'amber',
    permissions: [
      'dashboard.view',
      'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.adjust', 'inventory.export', 'inventory.delete',
      'transfers.view', 'transfers.create', 'transfers.approve', 'transfers.receive',
      'purchases.view', 'purchases.create',
      'reports.view', 'reports.export'
    ],
    description: 'Manage inventory, stock transfers, and purchasing'
  },
  finance: {
    label: 'Finance',
    color: 'green',
    permissions: [
      'dashboard.view', 'dashboard.export',
      'sales.view', 'sales.export',
      'purchases.view', 'purchases.export',
      'cash.view', 'cash.edit', 'cash.export',
      'reports.view', 'reports.export'
    ],
    description: 'View and manage financial reports and cash flows'
  },
  purchase_admin: {
    label: 'Purchase Admin',
    color: 'coral',
    permissions: [
      'dashboard.view',
      'purchases.create', 'purchases.view', 'purchases.edit', 'purchases.export',
      'vendors.view', 'vendors.create', 'vendors.edit',
      'reports.view'
    ],
    description: 'Manage vendor relationships and purchase orders'
  },
}

export const TAX_RATES = [
  { rate: 0, label: 'Exempt (0%)', examples: 'Essential goods, fresh produce, unprocessed staples' },
  { rate: 8, label: 'GST 8%',      examples: 'Standard taxable goods and provisions' },
]

// Sales trend data (last 14 days)
export const SALES_TREND = [
  { date: 'Apr 3',  sales: 82400,  purchases: 38000 },
  { date: 'Apr 4',  sales: 94200,  purchases: 12000 },
  { date: 'Apr 5',  sales: 78600,  purchases: 42000 },
  { date: 'Apr 6',  sales: 101200, purchases: 28000 },
  { date: 'Apr 7',  sales: 118400, purchases: 0 },
  { date: 'Apr 8',  sales: 68200,  purchases: 22000 },
  { date: 'Apr 9',  sales: 145600, purchases: 88000 },
  { date: 'Apr 10', sales: 92400,  purchases: 32000 },
  { date: 'Apr 11', sales: 108200, purchases: 18000 },
  { date: 'Apr 12', sales: 124600, purchases: 62000 },
  { date: 'Apr 13', sales: 98800,  purchases: 44000 },
  { date: 'Apr 14', sales: 136400, purchases: 38000 },
  { date: 'Apr 15', sales: 112600, purchases: 28000 },
  { date: 'Apr 16', sales: 124850, purchases: 48200 },
]
