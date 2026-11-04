// The car makes and models: shared by the server (it loads them as catalog variants) and both apps,
// so the lists open at once and work without a connection. Not every car in the world is here:
// the forms always offer "not in the list" and typing the car in by hand.
import type { BodyType } from './carLayouts.ts';
import { normalizeSearch } from './normalize.ts';

export type CarVariant = { id: string; make: string; model: string; bodyType: BodyType };

const BODIES: Record<string, BodyType> = { s: 'sedan', h: 'hatchback', w: 'wagon', u: 'suv', c: 'coupe', v: 'van', p: 'pickup' };

// [make, how people write it in Russian, 'Model:bodies; …'] — s sedan, h hatchback, w wagon, u crossover/SUV, c coupe, v van, p pickup.
const MAKES: Array<[string, string, string]> = [
  ['Lada', 'Лада ВАЗ Жигули', '2101:s;2104:w;2105:s;2106:s;2107:s;2108:h;2109:h;21099:s;2110:s;2111:w;2112:h;2113:h;2114:h;2115:s;4x4 (Нива Legend):u;Niva Travel:u;Granta:shw;Kalina:hw;Priora:shw;Vesta:sw;XRAY:h;Largus:wv;Samara:hs;Oka:h;Azimut:u;Aura:s'],
  ['Toyota', 'Тойота', 'Camry:s;Corolla:shw;Corolla Fielder:w;Corolla Axio:s;Corolla Cross:u;RAV4:u;Land Cruiser:u;Land Cruiser Prado:u;Highlander:u;Fortuner:u;Hilux:p;Tundra:p;Tacoma:p;Sequoia:u;4Runner:u;Venza:u;Harrier:u;C-HR:u;Yaris:hs;Yaris Cross:u;Vitz:h;Aqua:h;Prius:h;Prius Alpha:w;Auris:h;Avensis:sw;Mark II:s;Mark X:s;Chaser:s;Cresta:s;Crown:s;Crown Majesta:s;Altezza:s;Allion:s;Premio:s;Belta:s;Carina:s;Corona:s;Caldina:w;Wish:v;Ipsum:v;Isis:v;Noah:v;Voxy:v;Esquire:v;Sienta:v;Sienna:v;Alphard:v;Vellfire:v;Estima:v;Hiace:v;Town Ace:v;Passo:h;Ractis:h;Raize:u;Rush:u;Hilux Surf:u;FJ Cruiser:u;bZ4X:u;GT86:c;Supra:c;Celica:c;Probox:w'],
  ['Kia', 'Киа', 'Rio:sh;Rio X:h;Rio X-Line:h;Ceed:hw;ProCeed:w;Cerato:s;K3:s;K5:s;K8:s;K9:s;Optima:s;Stinger:h;Quoris:s;Soul:h;Picanto:h;Morning:h;Ray:h;Sportage:u;Seltos:u;Sorento:u;Mohave:u;Telluride:u;Niro:u;EV6:u;EV9:u;Carnival:v;Venga:v;Carens:v;Spectra:s;Magentis:s'],
  ['Hyundai', 'Хендай Хундай Хёндэ', 'Solaris:sh;Creta:u;Tucson:u;ix35:u;Santa Fe:u;Palisade:u;Elantra:s;Sonata:s;Grandeur:s;Accent:s;Getz:h;i20:h;i30:hw;i40:sw;Veloster:h;Genesis:s;Equus:s;Azera:s;Kona:u;Venue:u;Bayon:u;Terracan:u;Galloper:u;Matrix:v;Staria:v;H-1:v;Starex:v;Ioniq 5:u;Ioniq 6:s;Porter:p;Tiburon:c;Santamo:v'],
  ['Volkswagen', 'Фольксваген', 'Polo:sh;Golf:hw;Golf Plus:v;Jetta:s;Passat:sw;Passat CC:s;Arteon:h;Bora:s;Vento:s;Tiguan:u;Teramont:u;Touareg:u;Taos:u;T-Cross:u;T-Roc:u;Touran:v;Sharan:v;Caddy:v;Multivan:v;Transporter:v;Caravelle:v;Amarok:p;Scirocco:c;Beetle:c;Phaeton:s;ID.3:h;ID.4:u;ID.6:u;Lavida:s;Sagitar:s;Magotan:s;Tharu:u;Tayron:u'],
  ['Renault', 'Рено', 'Logan:s;Logan Stepway:s;Sandero:h;Sandero Stepway:h;Duster:u;Arkana:u;Kaptur:u;Koleos:u;Megane:hws;Fluence:s;Symbol:s;Clio:h;Laguna:shw;Scenic:v;Espace:v;Dokker:v;Kangoo:v;Trafic:v;Master:v;Talisman:s;Latitude:s'],
  ['Skoda', 'Шкода', 'Octavia:hw;Rapid:h;Fabia:hw;Superb:hw;Kodiaq:u;Karoq:u;Yeti:u;Kamiq:u;Roomster:v;Felicia:hw;Scala:h;Enyaq:u'],
  ['Nissan', 'Ниссан', 'Almera:s;Almera Classic:s;Sentra:s;Sunny:s;Bluebird:s;Teana:s;Maxima:s;Cefiro:s;Laurel:s;Skyline:sc;Cedric:s;Gloria:s;Fuga:s;Note:h;Tiida:hs;Micra:h;March:h;Juke:u;Qashqai:u;Terrano:u;X-Trail:u;Murano:u;Pathfinder:u;Patrol:u;Dualis:u;Rogue:u;Kicks:u;Leaf:h;Serena:v;Elgrand:v;Presage:v;Liberty:v;Lafesta:v;Wingroad:w;AD:w;Stagea:w;Cube:h;Navara:p;Frontier:p;GT-R:c;350Z:c;370Z:c'],
  ['Chery', 'Чери', 'Tiggo:u;Tiggo 2:u;Tiggo 2 Pro:u;Tiggo 3:u;Tiggo 4:u;Tiggo 4 Pro:u;Tiggo 5:u;Tiggo 7:u;Tiggo 7 Pro:u;Tiggo 7 Pro Max:u;Tiggo 8:u;Tiggo 8 Pro:u;Tiggo 8 Pro Max:u;Tiggo 9:u;Arrizo 5:s;Arrizo 7:s;Arrizo 8:s;Amulet:s;Bonus:h;Very:h;Fora:s;IndiS:h;M11:s;QQ:h'],
  ['Haval', 'Хавал', 'Jolion:u;F7:u;F7x:u;Dargo:u;Dargo X:u;H3:u;H5:u;H6:u;H7:u;H9:u;M6:u;Big Dog:u;Poer:p'],
  ['Geely', 'Джили', 'Atlas:u;Atlas Pro:u;Belgee X50:u;Boyue:u;Coolray:u;Tugella:u;Monjaro:u;Okavango:v;Preface:s;Emgrand:s;Emgrand 7:s;Emgrand X7:u;GC6:s;MK:s;MK Cross:h;Otaka:s;CK:s;Binrui:s;Xingyue:u'],
  ['BMW', 'БМВ', '1 серия:h;2 серия:c;2 серия Active Tourer:v;3 серия:sw;3 серия GT:h;4 серия:c;5 серия:sw;5 серия GT:h;6 серия:c;7 серия:s;8 серия:c;X1:u;X2:u;X3:u;X4:u;X5:u;X6:u;X7:u;XM:u;Z3:c;Z4:c;i3:h;i4:s;i5:s;i7:s;iX:u;iX1:u;iX3:u;M2:c;M3:s;M4:c;M5:s'],
  ['Mercedes-Benz', 'Мерседес', 'A-класс:hs;B-класс:v;C-класс:swc;CLA:s;CLK:c;CLS:s;E-класс:swc;S-класс:sc;SL:c;SLK:c;SLC:c;G-класс:u;GL:u;GLA:u;GLB:u;GLC:u;GLC Coupe:u;GLE:u;GLE Coupe:u;GLK:u;GLS:u;ML:u;R-класс:v;V-класс:v;Vito:v;Viano:v;Sprinter:v;X-класс:p;Maybach S-класс:s;AMG GT:c;EQA:u;EQB:u;EQC:u;EQE:su;EQS:su'],
  ['Audi', 'Ауди', 'A1:h;A3:sh;A4:sw;A4 Allroad:w;A5:hc;A6:sw;A6 Allroad:w;A7:h;A8:s;Q2:u;Q3:u;Q4 e-tron:u;Q5:u;Q7:u;Q8:u;e-tron:u;e-tron GT:s;TT:c;R8:c;RS3:s;RS4:w;RS5:c;RS6:w;RS7:h;RS Q8:u;S3:s;S4:s;S5:c;S6:s;S8:s;SQ5:u;SQ7:u;SQ8:u;80:sw;100:sw'],
  ['Ford', 'Форд', 'Focus:shw;Fiesta:hs;Mondeo:shw;Fusion:v;Kuga:u;EcoSport:u;Explorer:u;Expedition:u;Edge:u;Escape:u;Bronco:u;Maverick:u;C-Max:v;S-Max:v;Galaxy:v;Tourneo Connect:v;Tourneo Custom:v;Transit:v;Ranger:p;F-150:p;Mustang:c;Taurus:s;Territory:u;Scorpio:s;Sierra:s'],
  ['Mazda', 'Мазда', '2:h;3:sh;5:v;6:sw;323:sh;626:sw;CX-3:u;CX-30:u;CX-4:u;CX-5:u;CX-50:u;CX-60:u;CX-7:u;CX-8:u;CX-9:u;CX-90:u;Axela:sh;Atenza:sw;Demio:h;Familia:s;Capella:s;Millenia:s;Premacy:v;MPV:v;Biante:v;Tribute:u;BT-50:p;MX-5:c;RX-8:c;Bongo:v'],
  ['Mitsubishi', 'Мицубиси Митсубиси', 'Lancer:s;Lancer Evolution:s;Galant:s;Outlander:u;ASX:u;Eclipse Cross:u;Pajero:u;Pajero Sport:u;Pajero Mini:u;Montero:u;L200:p;Colt:h;Carisma:sh;Delica:v;Grandis:v;Minica:h;RVR:u;Airtrek:u;Mirage:h;i-MiEV:h;Space Star:h'],
  ['Honda', 'Хонда', 'Accord:s;Civic:sh;City:s;Fit:h;Jazz:h;CR-V:u;HR-V:u;Pilot:u;Vezel:u;ZR-V:u;Crosstour:u;Odyssey:v;Stepwgn:v;Freed:v;Stream:v;Shuttle:w;Insight:h;Legend:s;Inspire:s;Partner:w;Airwave:w;Element:u;Ridgeline:p;N-Box:h;Prelude:c;S2000:c'],
  ['Subaru', 'Субару', 'Forester:u;Outback:w;XV:u;Crosstrek:u;Impreza:shw;Impreza WRX:s;Legacy:sw;Levorg:w;Tribeca:u;Ascent:u;Solterra:u;BRZ:c;Exiga:v'],
  ['Lexus', 'Лексус', 'ES:s;GS:s;IS:s;LS:s;LC:c;LM:v;LX:u;GX:u;RX:u;RZ:u;NX:u;UX:u;TX:u;CT:h;RC:c;SC:c;HS:s'],
  ['Infiniti', 'Инфинити', 'FX:u;EX:u;JX:u;QX30:u;QX50:u;QX55:u;QX56:u;QX60:u;QX70:u;QX80:u;Q30:h;Q50:s;Q60:c;Q70:s;G:s;M:s'],
  ['Land Rover', 'Ленд Ровер', 'Defender:u;Discovery:u;Discovery Sport:u;Freelander:u;Range Rover:u;Range Rover Evoque:u;Range Rover Sport:u;Range Rover Velar:u'],
  ['Porsche', 'Порше', '911:c;718 Boxster:c;718 Cayman:c;Cayenne:u;Macan:u;Panamera:hw;Taycan:sw'],
  ['Volvo', 'Вольво', 'S40:s;S60:s;S70:s;S80:s;S90:s;V40:h;V50:w;V60:w;V70:w;V90:w;XC40:u;XC60:u;XC70:w;XC90:u;C30:h;EX30:u;EX90:u'],
  ['Opel', 'Опель', 'Astra:shw;Corsa:h;Insignia:shw;Vectra:shw;Mokka:u;Antara:u;Crossland:u;Grandland:u;Meriva:v;Zafira:v;Combo:v;Vivaro:v;Omega:sw;Frontera:u'],
  ['Peugeot', 'Пежо', '107:h;206:hs;207:h;208:h;301:s;307:hw;308:hw;406:sw;407:sw;408:hs;508:sw;2008:u;3008:u;4008:u;5008:u;Partner:v;Traveller:v;Boxer:v;Expert:v'],
  ['Citroen', 'Ситроен', 'C1:h;C2:h;C3:h;C3 Aircross:u;C3 Picasso:v;C4:hs;C4 Aircross:u;C4 Picasso:v;C5:sw;C5 Aircross:u;C-Crosser:u;C-Elysee:s;Berlingo:v;Jumper:v;Jumpy:v;SpaceTourer:v;Xsara:hs'],
  ['Chevrolet', 'Шевроле', 'Cruze:shw;Lacetti:shw;Aveo:sh;Cobalt:s;Lanos:s;Malibu:s;Spark:h;Epica:s;Rezzo:v;Orlando:v;Niva:u;Captiva:u;Equinox:u;Tahoe:u;Suburban:u;TrailBlazer:u;Traverse:u;Tracker:u;Camaro:c;Corvette:c;Silverado:p;Monza:s'],
  ['Daewoo', 'Дэу', 'Nexia:s;Matiz:h;Lanos:s;Gentra:s;Espero:s;Winstorm:u'],
  ['Ravon', 'Равон', 'R2:h;R3 Nexia:s;R4:s;Gentra:s'],
  ['Suzuki', 'Сузуки', 'Vitara:u;Grand Vitara:u;Jimny:u;SX4:uh;Swift:h;Baleno:hs;Liana:sw;Splash:h;Alto:h;Solio:v;Wagon R:h;Escudo:u;Kizashi:s;Hustler:h'],
  ['Exeed', 'Эксид', 'LX:u;TXL:u;VX:u;RX:u;Yaoguang:u'],
  ['Omoda', 'Омода', 'C5:u;S5:s;C7:u'],
  ['Jaecoo', 'Джейку', 'J7:u;J8:u'],
  ['Changan', 'Чанган', 'Alsvin:s;CS35:u;CS35 Plus:u;CS55:u;CS55 Plus:u;CS75:u;CS75 Plus:u;CS85:u;CS95:u;Eado:s;Eado Plus:s;Lamore:s;UNI-K:u;UNI-S:u;UNI-T:u;UNI-V:h;Hunter:p'],
  ['Tank', 'Танк', '300:u;400:u;500:u;700:u'],
  ['Jetour', 'Джетур', 'Dashing:u;T2:u;X50:u;X70:u;X70 Plus:u;X90 Plus:u'],
  ['Jetta', 'Джетта', 'VA3:s;VS5:u;VS7:u'],
  ['Great Wall', 'Грейт Вол', 'Deer:p;Hover:u;Hover H3:u;Hover H5:u;Hover H6:u;Safe:u;Poer:p;Wingle:p'],
  ['GAC', 'ГАК', 'GS3:u;GS4:u;GS5:u;GS8:u;GN8:v;Trumpchi M8:v;Empow:s;Aion S:s;Aion V:u;Aion Y:u'],
  ['BYD', 'БИД', 'Atto 3:u;Dolphin:h;Han:s;Qin:s;Seal:s;Seagull:h;Song Plus:u;Song Pro:u;Tang:u;Yuan Plus:u;F3:s'],
  ['Li Auto', 'Лисян Лисьян Li Xiang', 'L6:u;L7:u;L8:u;L9:u;Mega:v;One:u'],
  ['Zeekr', 'Зикр Зекр', '001:w;007:s;009:v;7X:u;X:u'],
  ['Voyah', 'Воя', 'Dream:v;Free:u;Passion:s;Courage:u'],
  ['Hongqi', 'Хончи Хунцы', 'E-HS9:u;H5:s;H7:s;H9:s;HS3:u;HS5:u;HS7:u'],
  ['Dongfeng', 'Донгфенг Дунфэн', '580:u;AX7:u;Aeolus A30:s;H30 Cross:h;Mage:s;Shine:s;S30:s;Forthing T5:u'],
  ['Forthing', 'Форсинг', 'T5 Evo:u;Yacht:v'],
  ['FAW', 'ФАВ', 'Bestune T55:u;Bestune T77:u;Bestune T99:u;Besturn B50:s;Besturn X40:u;Oley:s;V5:s'],
  ['Bestune', 'Бестюн', 'B70:s;NAT:v;T55:u;T77:u;T90:u;T99:u'],
  ['Kaiyi', 'Кайи', 'E5:s;X3:u;X3 Pro:u'],
  ['Livan', 'Ливан', 'S6 Pro:s;X3 Pro:u;X6 Pro:u;9:u'],
  ['Belgee', 'Белджи', 'S50:s;X50:u;X70:u'],
  ['Knewstar', 'Ньюстар', '001:u'],
  ['JAC', 'Джак', 'J7:h;JS3:u;JS4:u;JS6:u;JS8:u;S3:u;S5:u;S7:u;T6:p;T8:p'],
  ['Lifan', 'Лифан', 'Breez:s;Cebrium:s;Celliya:s;Myway:u;Murman:s;Smily:h;Solano:s;X50:u;X60:u;X70:u'],
  ['BAIC', 'БАИК', 'BJ40:u;BJ60:u;BJ80:u;EU5:s;U5 Plus:s;X35:u;X55:u;X7:u'],
  ['SWM', 'СВМ', 'G01:u;G01F:u;G05:u;Tiger:u'],
  ['Foton', 'Фотон', 'Tunland:p;Sauvana:u;View:v'],
  ['Wey', 'Вей', 'Coffee 01:u;Coffee 02:u;Latte:u;Mocha:u;VV5:u;VV7:u;07:v'],
  ['Deepal', 'Дипал', 'L07:s;S05:u;S07:u;SL03:s'],
  ['Avatr', 'Аватр', '07:u;11:u;12:h'],
  ['Aito', 'Айто Seres', 'M5:u;M7:u;M8:u;M9:u'],
  ['Xpeng', 'Икспенг', 'G3:u;G6:u;G9:u;P5:s;P7:s;X9:v'],
  ['Nio', 'Нио', 'EC6:u;EC7:u;ES6:u;ES7:u;ES8:u;ET5:s;ET7:s'],
  ['Tesla', 'Тесла', 'Cybertruck:p;Model 3:s;Model S:h;Model X:u;Model Y:u'],
  ['Genesis', 'Дженезис', 'G70:s;G80:s;G90:s;GV60:u;GV70:u;GV80:u'],
  ['Evolute', 'Эволют', 'i-Joy:u;i-Jet:s;i-Pro:h;i-Space:v;i-Sky:u;i-Van:v'],
  ['Xcite', 'Иксайт', 'X-Cross 7:u;X-Cross 8:u'],
  ['Solaris', 'Солярис', 'HC:h;HS:s;KRS:h;KRX:u'],
  ['Moskvich', 'Москвич', '3:u;3e:u;4:s;5:u;6:s;8:u;2140:s;2141:h;408:s;412:s'],
  ['Aurus', 'Аурус', 'Komendant:u;Senat:s'],
  ['UAZ', 'УАЗ', 'Hunter:u;Patriot:u;Pickup:p;Profi:p;Буханка (2206):v;Карго:v;469:u;3303:p;Симбир:u'],
  ['GAZ', 'ГАЗ', 'Volga 3102:s;Volga 31105:s;Volga Siber:s;Volga 24:s;Volga 31029:s;Газель:v;Газель NEXT:v;Газель NN:v;Соболь:v;Соболь NN:v;Баргузин:v;Sadko:p'],
  ['ZAZ', 'ЗАЗ', 'Chance:sh;Forza:sh;Lanos:s;Sens:s;Vida:sh;Таврия:h;Славута:h'],
  ['SsangYong', 'Ссанг Йонг СсангЙонг', 'Actyon:u;Korando:u;Kyron:u;Rexton:u;Rodius:v;Stavic:v;Tivoli:u;Musso:p'],
  ['Mini', 'Мини', 'Cooper:h;Clubman:w;Countryman:u;Paceman:u;Coupe:c'],
  ['Jeep', 'Джип', 'Cherokee:u;Compass:u;Gladiator:p;Grand Cherokee:u;Renegade:u;Wrangler:u;Commander:u;Liberty:u'],
  ['Dodge', 'Додж', 'Caliber:h;Caravan:v;Challenger:c;Charger:s;Durango:u;Journey:u;Nitro:u;RAM:p;Stratus:s'],
  ['RAM', 'РАМ', '1500:p;2500:p;3500:p;TRX:p'],
  ['Chrysler', 'Крайслер', '300C:s;Pacifica:v;PT Cruiser:h;Sebring:s;Voyager:v;Grand Voyager:v'],
  ['Cadillac', 'Кадиллак', 'ATS:s;BLS:s;CT5:s;CT6:s;CTS:s;Escalade:u;SRX:u;XT4:u;XT5:u;XT6:u;Lyriq:u'],
  ['GMC', 'ДжиЭмСи', 'Acadia:u;Hummer EV:p;Sierra:p;Terrain:u;Yukon:u'],
  ['Hummer', 'Хаммер', 'H1:u;H2:u;H3:u'],
  ['Lincoln', 'Линкольн', 'Aviator:u;Corsair:u;Navigator:u;Nautilus:u;MKX:u;MKZ:s;Town Car:s'],
  ['Acura', 'Акура', 'MDX:u;RDX:u;TLX:s;TSX:s;ZDX:u;NSX:c;RX:s'],
  ['Alfa Romeo', 'Альфа Ромео', '147:h;156:sw;159:sw;Giulia:s;Giulietta:h;Stelvio:u;Tonale:u'],
  ['Fiat', 'Фиат', '500:h;Albea:s;Bravo:h;Doblo:v;Ducato:v;Linea:s;Panda:h;Punto:h;Scudo:v;Tipo:sh'],
  ['Seat', 'Сеат', 'Alhambra:v;Ibiza:h;Leon:hw;Altea:v;Ateca:u;Toledo:s'],
  ['Cupra', 'Купра', 'Born:h;Formentor:u;Leon:hw'],
  ['Dacia', 'Дачия', 'Duster:u;Logan:sw;Sandero:h;Spring:h'],
  ['Saab', 'Сааб', '9-3:sw;9-5:sw'],
  ['Jaguar', 'Ягуар', 'E-Pace:u;F-Pace:u;F-Type:c;I-Pace:u;S-Type:s;X-Type:sw;XE:s;XF:sw;XJ:s'],
  ['Bentley', 'Бентли', 'Bentayga:u;Continental GT:c;Flying Spur:s;Mulsanne:s'],
  ['Rolls-Royce', 'Роллс-Ройс', 'Cullinan:u;Dawn:c;Ghost:s;Phantom:s;Spectre:c;Wraith:c'],
  ['Maserati', 'Мазерати', 'Ghibli:s;GranTurismo:c;Grecale:u;Levante:u;Quattroporte:s'],
  ['Ferrari', 'Феррари', '296 GTB:c;488:c;812:c;F8:c;Purosangue:u;Roma:c;SF90:c'],
  ['Lamborghini', 'Ламборгини', 'Aventador:c;Huracan:c;Revuelto:c;Urus:u'],
  ['Aston Martin', 'Астон Мартин', 'DB11:c;DBS:c;DBX:u;Rapide:s;Vantage:c'],
  ['Smart', 'Смарт', 'Forfour:h;Fortwo:c;#1:u;#3:u'],
  ['Daihatsu', 'Дайхатсу', 'Boon:h;Copen:c;Hijet:v;Mira:h;Move:h;Rocky:u;Sirion:h;Tanto:h;Terios:u;Thor:v'],
  ['Isuzu', 'Исузу', 'Bighorn:u;D-Max:p;MU-X:u;Trooper:u;Wizard:u'],
  ['Tagaz', 'Тагаз ТагАЗ', 'Road Partner:u;Tager:u;Vega:s;C10:h;C30:s'],
  ['Vortex', 'Вортекс', 'Corda:h;Estina:s;Tingo:u'],
  ['Brilliance', 'Бриллианс', 'FRV:h;FSV:s;H230:sh;H530:s;M1:s;V3:u;V5:u'],
  ['Zotye', 'Зоти', 'Coupa:s;T300:u;T600:u;Z300:s'],
  ['Haima', 'Хайма', '3:sh;7:u;M3:s;S5:u'],
  ['Skywell', 'Скайвелл', 'ET5:u;HT-i:u'],
  ['Rox', 'Рокс', '01:u;Adamas:u'],
  ['Maextro', 'Маэстро', 'S800:s'],
  ['Luxeed', 'Люксид', 'R7:u;S7:s'],
  ['MG', 'МГ', '3:h;5:s;6:s;HS:u;ZS:u;Marvel R:u;Cyberster:c;One:u'],
  ['Mahindra', 'Махиндра', 'Scorpio:u;Thar:u;XUV700:u'],
  ['Tata', 'Тата', 'Nexon:u;Safari:u;Tiago:h']
];

// Opened first in the list of makes: what comes in most often.
const POPULAR = new Set(['Lada', 'Toyota', 'Kia', 'Hyundai', 'Volkswagen', 'Renault', 'Skoda', 'Nissan', 'Chery', 'Haval', 'Geely', 'BMW', 'Mercedes-Benz', 'Audi', 'Ford', 'Mazda', 'Mitsubishi', 'Honda', 'Lexus', 'Changan']);

const slug = (value: string) => value.toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
const modelsOf = (text: string) => text.split(';').map((entry) => {
  const at = entry.lastIndexOf(':');
  return { name: entry.slice(0, at), bodies: [...entry.slice(at + 1)].map((code) => BODIES[code]) };
});
const sorted = (names: string[]) => [...names].sort((left, right) => left.localeCompare(right, 'ru', { numeric: true }));

/** Every make: the popular ones first, then the rest by name. */
export function carMakes(query = '') {
  const terms = normalizeSearch(query).split(' ').filter(Boolean);
  const matches = MAKES.filter(([make, russian]) => {
    const haystack = normalizeSearch(`${make} ${russian}`);
    return terms.every((term) => haystack.includes(term));
  }).map(([make]) => make);
  return terms.length ? sorted(matches) : [...matches.filter((make) => POPULAR.has(make)), ...sorted(matches.filter((make) => !POPULAR.has(make)))];
}

export function carModels(make: string, query = '') {
  const terms = normalizeSearch(query).split(' ').filter(Boolean);
  const row = MAKES.find(([name]) => name === make);
  if (!row) return [];
  return sorted(modelsOf(row[2]).map((model) => model.name).filter((name) => {
    const haystack = normalizeSearch(name);
    return terms.every((term) => haystack.includes(term));
  }));
}

/** One model in each body it was made in. */
export function carVariants(make: string, model: string): CarVariant[] {
  const row = MAKES.find(([name]) => name === make);
  const found = row && modelsOf(row[2]).find((entry) => entry.name === model);
  return found ? found.bodies.map((bodyType) => ({ id: `cat_${slug(make)}_${slug(model)}_${bodyType}`, make, model, bodyType })) : [];
}

/** All of it, for the server's table. */
export function allCarVariants(): CarVariant[] {
  return MAKES.flatMap(([make, , models]) => modelsOf(models).flatMap((model) => carVariants(make, model.name)));
}
