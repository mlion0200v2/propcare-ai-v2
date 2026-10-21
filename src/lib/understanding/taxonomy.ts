/**
 * Controlled taxonomy for understanding tenant reports.
 *
 * The model returns values from these lists (enforced by the zod schema),
 * the rules fast path maps words onto them, and the eval corpus is labelled
 * with them. Lexicon entries are lowercase; Latin words get typo tolerance
 * in rules.ts, Chinese terms are matched as substrings.
 */

export const EQUIPMENT = [
  "range_hood", "stove_oven", "microwave", "fridge", "dishwasher", "garbage_disposal",
  "washer", "dryer", "water_heater", "kitchen_sink", "bathroom_sink", "sink", "faucet",
  "toilet", "tub_shower", "pipe", "drain", "ceiling", "wall", "floor", "window", "door",
  "lock", "outlet", "light", "switch", "breaker", "smoke_alarm", "co_alarm", "furnace",
  "baseboard_heater", "thermostat", "ac", "bathroom_fan", "roof", "intercom", "unknown",
] as const;
export type Equipment = (typeof EQUIPMENT)[number];

export const SYMPTOMS = [
  "leaking", "not_working", "noisy", "smell", "clogged", "broken", "pests", "no_heat",
  "not_cooling", "no_hot_water", "sparking", "tripping", "beeping", "stuck", "running",
  "mold", "damaged", "other", "unknown",
] as const;
export type Symptom = (typeof SYMPTOMS)[number];

export const SUBSTANCES = ["water", "grease", "gas", "sewage", "oil", "smoke", "none", "unknown"] as const;
export type Substance = (typeof SUBSTANCES)[number];

export const ROOMS = [
  "kitchen", "bathroom", "bedroom", "living_room", "laundry", "basement", "hallway",
  "balcony", "garage", "exterior", "unknown",
] as const;
export type Room = (typeof ROOMS)[number];

export const ONSETS = ["just_now", "today", "yesterday", "days", "weeks", "unknown"] as const;
export type Onset = (typeof ONSETS)[number];

export const STATUSES = ["ongoing", "intermittent", "worsening", "stopped", "unknown"] as const;
export type Status = (typeof STATUSES)[number];

export const SEVERITIES = ["low", "medium", "high", "emergency"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Category used by the rest of the app (retrieval filter, routing). */
export const EQUIPMENT_CATEGORY: Record<Equipment, string> = {
  range_hood: "appliance", stove_oven: "appliance", microwave: "appliance", fridge: "appliance",
  dishwasher: "appliance", garbage_disposal: "appliance", washer: "appliance", dryer: "appliance",
  water_heater: "plumbing", kitchen_sink: "plumbing", bathroom_sink: "plumbing", sink: "plumbing",
  faucet: "plumbing", toilet: "plumbing", tub_shower: "plumbing", pipe: "plumbing", drain: "plumbing",
  ceiling: "structural", wall: "structural", floor: "flooring", window: "structural", door: "structural",
  lock: "locksmith", outlet: "electrical", light: "electrical", switch: "electrical", breaker: "electrical",
  smoke_alarm: "electrical", co_alarm: "electrical", furnace: "hvac", baseboard_heater: "hvac",
  thermostat: "hvac", ac: "hvac", bathroom_fan: "electrical", roof: "roofing", intercom: "electrical",
  unknown: "general",
};

/** Room an item is almost always in (so the tenant isn't asked). */
export const EQUIPMENT_ROOM: Partial<Record<Equipment, Room>> = {
  range_hood: "kitchen", stove_oven: "kitchen", microwave: "kitchen", fridge: "kitchen",
  dishwasher: "kitchen", garbage_disposal: "kitchen", kitchen_sink: "kitchen",
  bathroom_sink: "bathroom", toilet: "bathroom", tub_shower: "bathroom", bathroom_fan: "bathroom",
  washer: "laundry", dryer: "laundry",
};

/** Plain names (for prompts, summaries and questions). */
export const EQUIPMENT_LABEL: Record<Equipment, string> = {
  range_hood: "range hood", stove_oven: "stove or oven", microwave: "microwave", fridge: "fridge",
  dishwasher: "dishwasher", garbage_disposal: "garbage disposal", washer: "washing machine",
  dryer: "dryer", water_heater: "water heater", kitchen_sink: "kitchen sink", bathroom_sink: "bathroom sink",
  sink: "sink", faucet: "faucet", toilet: "toilet", tub_shower: "tub or shower", pipe: "pipe", drain: "drain",
  ceiling: "ceiling", wall: "wall", floor: "floor", window: "window", door: "door", lock: "lock",
  outlet: "outlet", light: "light", switch: "light switch", breaker: "breaker", smoke_alarm: "smoke alarm",
  co_alarm: "carbon monoxide alarm", furnace: "furnace", baseboard_heater: "baseboard heater",
  thermostat: "thermostat", ac: "air conditioner", bathroom_fan: "bathroom fan", roof: "roof",
  intercom: "intercom or buzzer", unknown: "something",
};

/**
 * Lexicon: words that name each value. Multi-word phrases also match joined
 * and hyphenated ("range hood" ↔ "rangehood" ↔ "range-hood"). Order within a
 * list doesn't matter; across items, longer phrases win.
 */
export const EQUIPMENT_LEXICON: Record<Exclude<Equipment, "unknown">, string[]> = {
  range_hood: ["range hood", "hood fan", "stove fan", "stove hood", "oven hood", "cooker hood", "vent hood", "exhaust hood", "kitchen fan", "kitchen exhaust", "range fan", "hood", "hotte", "hotte de cuisine", "抽油烟机", "油烟机", "抽烟机", "hood light", "range hood light", "hood lamp"],
  stove_oven: ["stove", "oven", "cooktop", "burner", "burners", "range", "four", "cuisinière", "cuisiniere", "plaque", "炉子", "灶", "炉灶", "烤箱"],
  microwave: ["microwave", "micro wave", "micro-ondes", "micro ondes", "微波炉"],
  fridge: ["fridge", "refrigerator", "freezer", "frig", "ice maker", "frigo", "réfrigérateur", "refrigerateur", "congélateur", "congelateur", "冰箱", "冷冻"],
  dishwasher: ["dishwasher", "dish washer", "lave-vaisselle", "lave vaisselle", "洗碗机"],
  garbage_disposal: ["garbage disposal", "disposal", "garburator", "garberator", "insinkerator", "broyeur", "垃圾处理器", "厨余粉碎机"],
  washer: ["washing machine", "washer", "clothes washer", "laveuse", "machine à laver", "machine a laver", "lave-linge", "洗衣机"],
  dryer: ["dryer", "drier", "clothes dryer", "sécheuse", "secheuse", "sèche-linge", "seche-linge", "烘干机", "干衣机"],
  water_heater: ["water heater", "hot water tank", "hot water heater", "hwt", "chauffe-eau", "chauffe eau", "热水器", "热水箱"],
  kitchen_sink: ["kitchen sink", "évier de cuisine", "厨房水槽", "厨房水池"],
  bathroom_sink: ["bathroom sink", "vanity", "lavabo", "洗手盆", "洗脸盆", "面盆"],
  sink: ["sink", "évier", "evier", "水槽", "水池"],
  faucet: ["faucet", "tap", "spout", "robinet", "水龙头", "龙头"],
  toilet: ["toilet", "loo", "commode", "toilette", "toilettes", "wc", "马桶", "厕所"],
  tub_shower: ["shower", "bathtub", "tub", "shower head", "douche", "baignoire", "淋浴", "花洒", "浴缸", "tub spout", "bath spout"],
  pipe: ["pipe", "pipes", "tuyau", "tuyaux", "水管", "管道"],
  drain: ["drain", "floor drain", "drain pipe", "renvoi", "drain de plancher", "下水道", "地漏"],
  ceiling: ["ceiling", "plafond", "天花板", "天花"],
  wall: ["wall", "walls", "mur", "murs", "墙", "墙壁", "drywall"],
  floor: ["floor", "flooring", "carpet", "tile", "tiles", "plancher", "sol", "地板", "地砖"],
  window: ["window", "windows", "screen", "fenêtre", "fenetre", "moustiquaire", "窗户", "窗", "纱窗"],
  door: ["door", "doors", "sliding door", "patio door", "porte", "门"],
  lock: ["lock", "locks", "deadbolt", "key", "keys", "serrure", "clé", "cle", "锁", "钥匙", "门锁", "locked out", "keypad", "smart lock"],
  outlet: ["outlet", "outlets", "plug", "socket", "receptacle", "gfci", "gfi", "prise", "prise électrique", "插座", "插头"],
  light: ["light", "lights", "lamp", "bulb", "light fixture", "ceiling light", "pot light", "pot lights", "lumière", "lumiere", "ampoule", "luminaire", "灯", "灯泡", "电灯"],
  switch: ["light switch", "switch", "interrupteur", "开关"],
  breaker: ["breaker", "breakers", "panel", "fuse", "disjoncteur", "fusible", "电闸", "保险丝", "跳闸", "breaker box", "electrical panel"],
  smoke_alarm: ["smoke alarm", "smoke detector", "fire alarm", "détecteur de fumée", "detecteur de fumee", "烟雾报警器", "烟感", "火警报警器"],
  co_alarm: ["carbon monoxide alarm", "carbon monoxide detector", "co alarm", "co detector", "détecteur de monoxyde", "一氧化碳报警器"],
  furnace: ["furnace", "boiler", "fournaise", "chaudière", "chaudiere", "锅炉", "暖炉"],
  baseboard_heater: ["baseboard heater", "baseboard", "wall heater", "heater", "radiator", "plinthe", "plinthe électrique", "calorifère", "calorifere", "radiateur", "暖气片", "取暖器"],
  thermostat: ["thermostat", "temperature control", "温控器", "恒温器"],
  ac: ["air conditioner", "air conditioning", "ac unit", "a/c", "climatiseur", "climatisation", "空调", "air con", "aircon", "ac", "clim"],
  bathroom_fan: ["bathroom fan", "bath fan", "exhaust fan", "vent fan", "ventilateur de salle de bain", "排气扇", "换气扇", "ventilateur", "fan"],
  roof: ["roof", "gutter", "gutters", "toit", "toiture", "gouttière", "屋顶", "房顶"],
  intercom: ["intercom", "buzzer", "doorbell", "interphone", "门铃", "对讲机", "门禁"],
};

export const SYMPTOM_LEXICON: Record<Exclude<Symptom, "unknown" | "other">, string[]> = {
  leaking: ["leak", "leaks", "leaking", "leaked", "leaky", "drip", "drips", "dripping", "seeping", "puddle", "pooling", "fuit", "fuite", "coule", "goutte", "漏", "漏水", "滴", "滴水", "渗水", "burst", "bursted", "gushing", "spraying", "flooding", "flooded", "overflowing", "water on the floor", "coming through", "comes in", "爆", "爆了"],
  not_working: ["not working", "doesn't work", "does not work", "dont work", "won't turn on", "wont turn on", "won't start", "dead", "stopped working", "broken down", "no power", "ne fonctionne pas", "ne marche pas", "marche pas", "en panne", "不工作", "坏了", "不能用", "没反应", "不转", "不亮", "doesn't turn on", "doesnt turn on", "isn't working", "isnt working", "not turning on", "won't work", "wont work", "does nothing", "doesn't do anything", "doesnt do anything", "not responding", "isn't responding", "unresponsive", "blank", "stopped", "stops", "won't spin", "wont spin", "doesn't spin", "not spinning", "won't light", "wont light", "is out", "went out", "burnt out", "burned out", "flicker", "flickers", "flickering", "error", "error code", "ne marche plus", "ne fonctionne plus", "启动不了", "点不着", "没电", "没电了", "不动", "low pressure", "low water pressure", "weak pressure", "no water pressure"],
  noisy: ["noise", "noisy", "loud", "rattling", "banging", "squeaking", "grinding", "humming", "buzzing", "bruit", "bruyant", "噪音", "很吵", "响", "异响", "bang", "bangs", "loudly", "squeak", "squeaks", "rattle", "rattles", "popping noises", "clanking"],
  smell: ["smell", "smells", "odor", "odour", "stink", "stinks", "stinky", "odeur", "sent", "味道", "臭", "闻到", "smells burnt", "burning smell", "气味", "味", "霉味"],
  clogged: ["clog", "clogged", "clogged up", "blocked", "backed up", "slow drain", "draining slowly", "plugged", "won't drain", "wont drain", "not draining", "doesn't drain", "doesnt drain", "won't flush", "wont flush", "bouché", "bouche", "obstrué", "堵", "堵了", "堵塞", "不通", "drains slowly", "drains slow", "drains really slowly", "drains really slow", "draining slower", "standing water", "water sitting", "full of water", "overflowing", "backing up", "ne se vide pas", "ne vide pas", "不排水", "排水慢"],
  broken: ["broken", "snapped", "fell off", "came off", "damaged", "brisé", "brise", "cassé", "casse", "坏", "裂", "断了", "掉了", "broke", "busted", "loose", "kaput"],
  pests: ["pest", "pests", "bug", "bugs", "ants", "ant", "cockroach", "cockroaches", "roach", "roaches", "mice", "mouse", "rat", "rats", "bedbugs", "bed bugs", "termites", "cafards", "coquerelles", "souris", "punaises", "fourmis", "蟑螂", "老鼠", "蚂蚁", "臭虫", "虫", "wasp", "wasps", "hornet", "hornets", "wasp nest", "droppings", "scratching", "bites", "guêpes"],
  no_heat: ["no heat", "not heating", "won't heat", "doesn't heat", "so cold", "too cold", "it's cold", "freezing", "pas de chauffage", "ne chauffe pas", "没有暖气", "不热", "不暖", "很冷", "doesn't get warm", "doesnt get warm", "doesn't warm up", "won't warm up", "not getting hot", "not geting hot", "doesn't get hot", "won't heat up", "not heating up", "ne chauffe plus", "pas de chaleur", "暖气不热", "没暖气"],
  not_cooling: ["not cooling", "not cold", "isn't cold", "warm", "won't cool", "not keeping cold", "pas froid", "不制冷", "不冷", "isn't cooling", "isnt cooling", "not cool", "won't cool down", "blowing warm", "ne refroidit plus", "ne refroidit pas"],
  no_hot_water: ["no hot water", "only cold water", "pas d'eau chaude", "没有热水", "没热水", "plus d'eau chaude", "pas d eau chaude", "plus d eau chaude", "no hot", "hot water is out"],
  sparking: ["spark", "sparks", "sparking", "arcing", "étincelle", "etincelle", "étincelles", "火花", "冒火花", "sparked"],
  tripping: ["tripping", "trips", "tripped", "keeps tripping", "saute", "disjoncte", "跳闸", "popping", "pops", "trip"],
  beeping: ["beep", "beeps", "beeping", "chirp", "chirps", "chirping", "bip", "bips", "嘀嘀", "响个不停", "报警"],
  stuck: ["stuck", "jammed", "jam", "won't open", "won't close", "won't lock", "bloqué", "bloque", "coincé", "coince", "卡住", "打不开", "关不上", "hard to turn", "hard to open", "sticks", "sticking", "won't slide", "wont slide", "won't close", "wont close", "wont lock", "won't stay", "ne ferme plus", "ne ferme pas"],
  running: ["keeps running", "runs constantly", "constantly running", "won't stop running", "coule sans arrêt", "一直流", "一直响", "keeps refilling", "refilling", "keeps filling", "hissing", "won't stop", "wont stop", "running nonstop", "won't turn off", "wont turn off", "doesn't turn off", "turn off all the way", "流水", "一直在流水"],
  mold: ["mold", "mould", "mildew", "moisissure", "moisissures", "发霉", "霉"],
  damaged: ["hole", "crack", "stain", "water stain", "peeling", "sagging", "trou", "fissure", "tache", "洞", "裂缝", "水渍", "cracked", "condensation", "lifting", "warped", "bubbling"],
};

export const SUBSTANCE_LEXICON: Record<Exclude<Substance, "unknown" | "none">, string[]> = {
  water: ["water", "wet", "eau", "水", "rain", "raining", "eau chaude"],
  grease: ["grease", "greasy", "graisse", "graisseux", "油污", "油滴"],
  gas: ["gas", "natural gas", "propane", "gaz", "煤气", "燃气", "天然气", "gass", "rotten egg", "rotten eggs", "煤气味"],
  sewage: ["sewage", "sewer", "poop", "feces", "égout", "egout", "eaux usées", "粪水", "污水"],
  oil: ["oil", "oily", "huile", "油"],
  smoke: ["smoke", "smoking", "fumée", "fumee", "烟", "冒烟", "burning", "burnt", "burning smell", "smells burnt", "burning plastic"],
};

export const ROOM_LEXICON: Record<Exclude<Room, "unknown">, string[]> = {
  kitchen: ["kitchen", "cuisine", "厨房"],
  bathroom: ["bathroom", "washroom", "ensuite", "en-suite", "powder room", "restroom", "salle de bain", "salle de bains", "浴室", "卫生间", "洗手间", "厕所"],
  bedroom: ["bedroom", "master bedroom", "chambre", "卧室"],
  living_room: ["living room", "lounge", "family room", "salon", "客厅"],
  laundry: ["laundry", "laundry room", "utility room", "buanderie", "洗衣房"],
  basement: ["basement", "sous-sol", "sous sol", "地下室"],
  hallway: ["hallway", "hall", "corridor", "couloir", "走廊", "过道"],
  balcony: ["balcony", "patio", "deck", "balcon", "阳台"],
  garage: ["garage", "parking", "车库"],
  exterior: ["exterior", "yard", "extérieur", "室外"],
};

export const ONSET_LEXICON: Record<Exclude<Onset, "unknown">, string[]> = {
  just_now: ["just now", "just started", "right now", "a minute ago", "minutes ago", "tout à l'heure", "à l'instant", "刚刚", "刚才"],
  today: ["today", "this morning", "this afternoon", "tonight", "this evening", "aujourd'hui", "ce matin", "ce soir", "今天", "今早", "今晚"],
  yesterday: ["yesterday", "last night", "hier", "昨天", "昨晚"],
  days: ["few days", "couple of days", "couple days", "days ago", "since monday", "since tuesday", "since the weekend", "this week", "depuis quelques jours", "几天", "好几天", "这几天"],
  weeks: ["weeks", "a week", "last week", "a month", "months", "for a while", "depuis des semaines", "一个星期", "几个星期", "一个月", "很久"],
};

export const STATUS_LEXICON: Record<Exclude<Status, "unknown">, string[]> = {
  ongoing: ["still", "constantly", "non-stop", "nonstop", "all the time", "right now", "toujours", "sans arrêt", "一直", "还在"],
  intermittent: ["sometimes", "on and off", "comes and goes", "now and then", "occasionally", "parfois", "de temps en temps", "有时候", "时不时"],
  worsening: ["getting worse", "worse", "spreading", "more and more", "s'aggrave", "de plus en plus", "越来越", "更严重"],
  stopped: ["stopped", "it stopped", "not anymore", "fixed itself", "s'est arrêté", "停了", "不漏了"],
};
