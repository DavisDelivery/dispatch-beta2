// Starter orders — real UAT stops (created via the write fn) so the board has
// something to plan out of the box. Each carries its real stopId, so they plan
// onto a load with no extra read. Merged once into the registry (see
// createdOrders.js seedCreatedOrders); a per-browser flag means deleting one
// won't resurrect it.
export const SEED_VERSION = 'v1'

export const SEED_ORDERS = [
  { stopNbr: '007138869', stopId: '6a3f11c53e328714d44a523d', name: 'TOTAL WIRELESS', addr1: '7184 ROCKBRIDGE RD', addr2: 'STE 1102A', city: 'STONE MOUNTAIN', state: 'GA', zip: '30087', pallets: 1 },
  { stopNbr: '007139395', stopId: '6a3f11c63e328714d44a523f', name: 'UNITED WAY OF GREATER ATLANTA', addr1: '40 COURTLAND ST NE', addr2: '', city: 'ATLANTA', state: 'GA', zip: '30303', pallets: 1 },
  { stopNbr: '007139396', stopId: '6a3f11c73e328714d44a5241', name: 'AMAZON.COM SERVICES LLC HAT2', addr1: '7520 FACTORY SHOALS RD', addr2: '', city: 'AUSTELL', state: 'GA', zip: '30168', pallets: 1 },
  { stopNbr: '007139397', stopId: '6a3f11c8a369e5089e6c020f', name: 'SOCIETAL CDMO GAINESVILLE LLC', addr1: '1300 GOULD DR', addr2: '', city: 'GAINESVILLE', state: 'GA', zip: '30504', pallets: 2 },
  { stopNbr: '007139398', stopId: '6a3f11c9a369e5089e6c0211', name: 'NON INV GUARDSHACK AMAZON ATL2', addr1: '2257 W PARK PLACE BLVD', addr2: '', city: 'STONE MOUNTAIN', state: 'GA', zip: '30087', pallets: 1 },
  { stopNbr: '007139399', stopId: '6a3f11ca3e328714d44a5243', name: 'SIENHUA GROUP INC', addr1: '1055 BIG SHANTY RD NW', addr2: '# 300', city: 'KENNESAW', state: 'GA', zip: '30144', pallets: 1 },
  { stopNbr: '007139400', stopId: '6a3f11cba369e5089e6c0213', name: 'GA POWER TRANSMISSION SERVICES', addr1: '62 LAKE MIRROR ROAD', addr2: '', city: 'FOREST PARK', state: 'GA', zip: '30297', pallets: 2 },
  { stopNbr: '007139401', stopId: '6a3f11cda369e5089e6c0215', name: 'BROWN OX VENTURES INC', addr1: '1415 CLEVELAND HWY', addr2: '', city: 'DALTON', state: 'GA', zip: '30721', pallets: 1 },
  { stopNbr: '007139402', stopId: '6a3f11d93e328714d44a5245', name: 'CATALYST NUTRACEUTICALS', addr1: '1720 PEACHTREE IND BLVD', addr2: 'STE A', city: 'BUFORD', state: 'GA', zip: '30518', pallets: 1 },
]
