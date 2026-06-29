// Drivers for the tenant we WRITE to. Currently UAT (DAVISV5) — the enabled
// accounts that carry the NuVizz DI_Driver role (i.e. every user assignable as a
// load's driver). UAT is a shared NuVizz test sandbox, so this includes NuVizz
// internal test accounts; that's intentional — it's "what's in UAT". `userName`
// is the key NuVizz identifies a load's driver by.
//
// HOW THIS WAS BUILT (repeat for the DAVIS production switch):
//   POST {BASE}/user/list/{COMPANY}   (Basic auth = NUVIZZ_DAVIS_USER:PASS)
//   body: {"pageInfo":{"pageSize":0,"page":1,"maxResult":500},
//          "searchCriteria":{"name":"","groupNames":["-1"],"vendorId":["-1"],
//          "email":"","userRoles":["-1"],"status":"-1","companyId":""}}
//   then keep accountStatus==ENABLED with the DI_Driver role. For production DAVIS
//   the roster is clean enough to also drop office roles (DI_Dispatcher, MemberAdmin,
//   GroupAdmin, Account_CSR, DI_Biller, ...) -> 60 road drivers.
export const KNOWN_DRIVERS = [
  { userName: 'ABI', name: 'abi user', mobile: '' },
  { userName: 'ABI1', name: 'abi user', mobile: '' },
  { userName: 'AKASHD12', name: 'Akash D', mobile: '' },
  { userName: 'ARVDRIVER', name: 'arv driver', mobile: '9900990099' },
  { userName: 'ARVIND', name: 'arv ind', mobile: '9900990099' },
  { userName: 'GSHAFIULLA', name: 'Attar Shafi', mobile: '' },
  { userName: 'BHARGAV', name: 'Bhargav Nuvizz', mobile: '' },
  { userName: 'BILL', name: 'Bill Bill', mobile: '' },
  { userName: 'CHAD', name: 'Chad Davis', mobile: '' },
  { userName: 'DPATIL', name: 'D Patil', mobile: '' },
  { userName: 'DADMIN', name: 'Davis admin', mobile: '' },
  { userName: 'DIBYASINGH', name: 'Dibyasingh Pallai', mobile: '' },
  { userName: 'DILIP', name: 'dilip s', mobile: '' },
  { userName: 'GREG', name: 'Greg P', mobile: '' },
  { userName: 'HBATTULURI', name: 'hareesh battuluri', mobile: '8977819802' },
  { userName: 'HARISHKC', name: 'Harish K C', mobile: '9108838757' },
  { userName: 'HARSHA', name: 'Harsha S', mobile: '' },
  { userName: 'HARSHAV5', name: 'Harsha SV5', mobile: '' },
  { userName: 'HIDAYATH', name: 'Hidayath N', mobile: '' },
  { userName: 'HBASHA1', name: 'hussain basha', mobile: '' },
  { userName: 'HBASHA', name: 'hussain basha', mobile: '7019284811' },
  { userName: 'IMRAN', name: 'Imran V5', mobile: '' },
  { userName: 'JAMES12', name: 'James P', mobile: '' },
  { userName: 'JAVEED', name: 'Javeed S', mobile: '' },
  { userName: 'JEET', name: 'jeet singh Poonia', mobile: '' },
  { userName: 'JIYO', name: 'Jiyo G', mobile: '' },
  { userName: 'JOHN12', name: 'John Mike', mobile: '' },
  { userName: 'JOHN', name: 'John Shelby', mobile: '' },
  { userName: 'SHERRY', name: 'john sherry', mobile: '' },
  { userName: 'KRISH2233', name: 'krishna dodamani', mobile: '' },
  { userName: 'LDR1', name: 'Libin Driver', mobile: '' },
  { userName: 'MKUMAR', name: 'Mala Madhukumar', mobile: '' },
  { userName: 'MANOJ12', name: 'Manoj Kumar', mobile: '' },
  { userName: 'NINJA', name: 'Ninja Hatoori', mobile: '' },
  { userName: 'PILOTDEV1', name: 'Pilot Dev1', mobile: '' },
  { userName: 'PIYUSH', name: 'piyush nuvizz', mobile: '' },
  { userName: 'PRAGATHI', name: 'Pragathi B', mobile: '' },
  { userName: 'RAKESH', name: 'Rakesh B', mobile: '' },
  { userName: 'ROHITH', name: 'Rohith B', mobile: '' },
  { userName: 'SROOPA', name: 'Roopa S', mobile: '' },
  { userName: 'SNEW', name: 'SNEW TEST', mobile: '' },
  { userName: 'SREENATH', name: 'Sreenath Unni', mobile: '' },
  { userName: 'STEVE', name: 'steve M', mobile: '' },
  { userName: 'SUBIN', name: 'Subin P B', mobile: '' },
  { userName: '#SUMAN', name: 'Suman Rao', mobile: '' },
  { userName: 'SURYAD', name: 'surya davis', mobile: '8247438602' },
  { userName: 'SUSHANTHS', name: 'Sushanth S', mobile: '' },
  { userName: 'TESTMEMBER', name: 'Test member', mobile: '9988776655' },
  { userName: 'SHELBY', name: 'Thomas Shelby', mobile: '' },
  { userName: 'VENU', name: 'Venu C', mobile: '' },
  { userName: 'VICKY', name: 'Vicky D', mobile: '' },
  { userName: 'VIZZRAO', name: 'Vizz Rao', mobile: '4046633294' },
  { userName: 'ZACH', name: 'Zach Johnston', mobile: '' },
]
