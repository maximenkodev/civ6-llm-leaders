-- ===========================================================================
-- LLM Leaders — UI-контекст мода.
--
-- Связь с мостом (bridge) идёт через FireTuner:
--   мост -> игра : вызывает LLM_Deliver({...}) в этом контексте
--   игра -> мост : мост вызывает LLM_Poll() / LLM_Snapshot(), а мы печатаем
--                  пакеты "LLMQ|..." (hex JSON), которые возвращаются по сокету.
-- Игровые действия (золото, ресурсы, война/мир) мост выполняет сам
-- в контексте GameCore_Tuner — здесь только интерфейс и сбор данных.
-- ===========================================================================

include("InstanceManager");
include("LLMJson");

local m_LeaderIM = InstanceManager:new("LeaderInstance", "Button", Controls.LeaderStack);
local m_MsgIM    = InstanceManager:new("MessageInstance", "Root", Controls.MessageStack);

local MAX_MESSAGES   = 80;
local MAX_FEED_ITEMS = 400;
local BRIDGE_TIMEOUT = 4.0;   -- сек без опроса = мост отключён

-- Особые «собеседники» в списке слева
local SEL_NONE      = -1;
local FEED_WORLD    = -10;    -- «Мировая хроника»: переговоры лидеров между собой
local FEED_TREATIES = -11;    -- «Договоры и блоки»
local FEEDS = { world = FEED_WORLD, treaties = FEED_TREATIES };

local function IsFeed(pid) return pid == FEED_WORLD or pid == FEED_TREATIES; end

local g_Outbox        = {};   -- события для моста
local g_Conversations = {};   -- [pid] = { {author=, text=, kind=} }
local g_Unread        = {};   -- [pid] = n
local g_Typing        = {};   -- [pid] = true
local g_Deals         = {};   -- [pid] = {id=, text=}
local g_Selected      = SEL_NONE;
local g_Time          = 0;
local g_LastPoll      = -100;
local g_LastStatusAt  = 0;
local g_BridgeInfo    = "";
local g_AllowUnmet    = false;

-- ---------------------------------------------------------------------------
-- Утилиты
-- ---------------------------------------------------------------------------
local function Safe(fn, default)
	local ok, r = pcall(fn);
	if ok and r ~= nil then return r; end
	return default;
end

local function CurrentTurn()
	return Safe(function() return Game.GetCurrentGameTurn(); end, 0);
end

local function Enqueue(ev)
	ev.turn = CurrentTurn();
	table.insert(g_Outbox, ev);
end

local function LocalID()
	return Safe(function() return Game.GetLocalPlayer(); end, -1);
end

local function IsMajorAI(pid)
	return Safe(function()
		local p = Players[pid];
		return p ~= nil and p:IsMajor() and (not p:IsHuman()) and p:IsAlive();
	end, false);
end

-- Свои имена из personas.yaml (присылает мост): g_Names["<id>"] = {leader=, civ=}
g_Names = g_Names or {};

local function LeaderDisplay(pid)
	local over = g_Names[tostring(pid)];
	local cfg = PlayerConfigurations[pid];
	local leader = Safe(function() return Locale.Lookup(cfg:GetLeaderName()); end, "Игрок " .. tostring(pid));
	local civ    = Safe(function() return Locale.Lookup(cfg:GetCivilizationShortDescription()); end, "");
	if type(over) == "table" then
		leader = over.leader or leader;
		civ = over.civ or civ;
	end
	return leader, civ;
end

local function DiploStateName(fromID, toID)
	return Safe(function()
		local idx = Players[fromID]:GetDiplomaticAI():GetDiplomaticStateIndex(toID);
		return Locale.Lookup(GameInfo.DiplomaticStates[idx].Name);
	end, "");
end

local function GetContactIDs()
	local ids = {};
	local localID = LocalID();
	if localID < 0 then return ids; end
	local pLocal = Players[localID];
	for _, p in ipairs(PlayerManager.GetAliveMajors()) do
		local id = p:GetID();
		if id ~= localID and not p:IsHuman() then
			local met = Safe(function() return pLocal:GetDiplomacy():HasMet(id); end, false);
			if met or g_AllowUnmet then table.insert(ids, id); end
		end
	end
	return ids;
end

-- Игра не понимает "\n" в подписях (рисует квадратик) — нужен тег [NEWLINE]
local function UIText(s)
	s = tostring(s or "");
	s = string.gsub(s, "\r", "");
	s = string.gsub(s, "\n", "[NEWLINE]");
	return s;
end

-- Договоры игрока с каждым лидером (присылает мост): g_TreatyInfo["<id>"] = "строка"
g_TreatyInfo = g_TreatyInfo or {};

local function AddMessage(pid, author, text, kind)
	if pid == nil or (pid < 0 and not IsFeed(pid)) then return; end
	g_Conversations[pid] = g_Conversations[pid] or {};
	local conv = g_Conversations[pid];
	table.insert(conv, { author = UIText(author), text = UIText(text), kind = kind or "leader" });
	local max = IsFeed(pid) and MAX_FEED_ITEMS or MAX_MESSAGES;
	while #conv > max do table.remove(conv, 1); end
end

local function SetBg(inst, r, g, b)
	pcall(function() inst.Bg:SetColor(UI.GetColorValue(r, g, b, 0.9)); end);
end

local function IsOpen()
	return not Controls.Window:IsHidden();
end

-- ---------------------------------------------------------------------------
-- Отрисовка
-- ---------------------------------------------------------------------------
local function UpdateOpenButton()
	local total = 0;
	for _, n in pairs(g_Unread) do total = total + n; end
	if total > 0 then
		Controls.OpenButton:SetText("ИИ-дипломатия (" .. total .. ")");
	else
		Controls.OpenButton:SetText("ИИ-дипломатия");
	end
end

local function UpdateBridgeStatus()
	if (g_Time - g_LastPoll) > BRIDGE_TIMEOUT then
		Controls.BridgeStatus:SetText("[COLOR_RED]Мост не подключён[ENDCOLOR] — запустите bridge (start.bat)");
	else
		Controls.BridgeStatus:SetText("[COLOR_GREEN]Мост подключён[ENDCOLOR]  " .. g_BridgeInfo);
	end
end

local function AddFeedEntry(pid, title, info)
	local inst = m_LeaderIM:GetInstance();
	local name = title;
	if (g_Unread[pid] or 0) > 0 then name = name .. "  (" .. g_Unread[pid] .. ")"; end
	inst.Name:SetText("[COLOR_LIGHTBLUE]" .. name .. "[ENDCOLOR]");
	inst.Info:SetText(info);
	SetBg(inst, 0.20, 0.13, 0.30);
	inst.Button:RegisterCallback(Mouse.eLClick, function() SelectLeader(pid); end);
	if inst.Sel then inst.Sel:SetHide(pid ~= g_Selected); end
end

local function RefreshLeaders()
	m_LeaderIM:ResetInstances();
	local localID = LocalID();
	AddFeedEntry(FEED_WORLD, "Мировая хроника", "переговоры между лидерами");
	AddFeedEntry(FEED_TREATIES, "Договоры и блоки", "действующие соглашения");
	for _, id in ipairs(GetContactIDs()) do
		local inst = m_LeaderIM:GetInstance();
		SetBg(inst, 0.08, 0.18, 0.29);
		local leader, civ = LeaderDisplay(id);
		local name = leader;
		if (g_Unread[id] or 0) > 0 then name = name .. "  (" .. g_Unread[id] .. ")"; end
		if g_Typing[id] then name = name .. "  …"; end
		inst.Name:SetText(name);
		local info = civ;
		local st = DiploStateName(id, localID);
		if st ~= "" then info = info .. " · " .. st; end
		inst.Info:SetText(info);
		inst.Button:RegisterCallback(Mouse.eLClick, function() SelectLeader(id); end);
		if inst.Sel then inst.Sel:SetHide(id ~= g_Selected); end
	end
	Controls.LeaderStack:CalculateSize();
	Controls.LeaderScroll:CalculateInternalSize();
end

local function RenderMessage(m)
	local inst = m_MsgIM:GetInstance();
	if m.kind == "player" then
		inst.Author:SetText("[COLOR_LIGHTBLUE]" .. m.author .. "[ENDCOLOR]");
	elseif m.kind == "system" then
		inst.Author:SetText("[COLOR_Grey]" .. m.author .. "[ENDCOLOR]");
	else
		inst.Author:SetText(m.author);
	end
	inst.Text:SetText(m.text);
	pcall(function() inst.Text:SetHide(m.text == nil or m.text == ""); end);
end

-- Раскладка правой части: строка договоров, панель сообщений, карточка сделки и поле ввода
-- не должны наползать друг на друга — высоты считаем по фактическому тексту.
local function LayoutChat()
	pcall(function()
		local H = Controls.ChatArea:GetSizeY();
		local top = 42;
		local tr = Controls.LeaderTreaties;
		if not tr:IsHidden() and (tr:GetText() or "") ~= "" then
			top = 40 + tr:GetSizeY() + 6;
		end
		local inputHidden = Controls.InputArea:IsHidden();
		local bottom = inputHidden and H or (H - 36 - 8);
		if not Controls.DealCard:IsHidden() then
			local ch = math.max(58, Controls.DealText:GetSizeY() + 16);
			Controls.DealCard:SetSizeY(ch);
			Controls.DealBg:SetSizeY(ch);
			bottom = H - 44 - ch - 6;
		end
		local h = math.max(80, bottom - top);
		Controls.MessagePanel:SetOffsetY(top);
		Controls.MessagePanel:SetSizeY(h);
		Controls.MessageBg:SetSizeY(h);
		Controls.MessageScroll:SetSizeY(h - 8);
	end);
	Controls.MessageStack:CalculateSize();
	Controls.MessageScroll:CalculateInternalSize();
end

local function RefreshMessages()
	m_MsgIM:ResetInstances();
	local feed = IsFeed(g_Selected);
	pcall(function() Controls.InputArea:SetHide(feed or g_Selected == SEL_NONE); end);
	-- договоры с выбранным лидером
	local tinfo = (g_Selected >= 0) and g_TreatyInfo[tostring(g_Selected)] or nil;
	Controls.LeaderTreaties:SetText(tinfo and UIText(tinfo) or "");
	Controls.LeaderTreaties:SetHide(tinfo == nil or tinfo == "");
	if g_Selected == SEL_NONE then
		Controls.LeaderHeader:SetText("Выберите лидера слева");
		Controls.LeaderSubHeader:SetText("");
		Controls.DealCard:SetHide(true);
		LayoutChat();
		return;
	end

	if feed then
		if g_Selected == FEED_WORLD then
			Controls.LeaderHeader:SetText("Мировая хроника");
			Controls.LeaderSubHeader:SetText("Переговоры лидеров между собой, договоры, нарушения и союзнический долг");
		else
			Controls.LeaderHeader:SetText("Договоры и блоки");
			Controls.LeaderSubHeader:SetText("Действующие соглашения и альянсы мира");
		end
		Controls.DealCard:SetHide(true);
		local list = g_Conversations[g_Selected] or {};
		if #list == 0 then
			RenderMessage({ author = "", text = "[COLOR_Grey]Пока пусто. Лидеры ведут переговоры в начале ваших ходов.[ENDCOLOR]", kind = "leader" });
		end
		for _, m in ipairs(list) do RenderMessage(m); end
		LayoutChat();
		-- хронику показываем с новых записей (внизу), реестр — сверху
		Controls.MessageScroll:SetScrollValue(g_Selected == FEED_WORLD and 1 or 0);
		return;
	end

	local leader, civ = LeaderDisplay(g_Selected);
	Controls.LeaderHeader:SetText(leader .. " — " .. civ);
	Controls.LeaderSubHeader:SetText(DiploStateName(g_Selected, LocalID()));

	for _, m in ipairs(g_Conversations[g_Selected] or {}) do RenderMessage(m); end
	if g_Typing[g_Selected] then
		local inst = m_MsgIM:GetInstance();
		inst.Author:SetText(leader);
		inst.Text:SetText("[COLOR_Grey]…обдумывает ответ[ENDCOLOR]");
	end

	local deal = g_Deals[g_Selected];
	if deal ~= nil then
		Controls.DealText:SetText(UIText(deal.text));
		Controls.DealCard:SetHide(false);
	else
		Controls.DealCard:SetHide(true);
	end

	LayoutChat();
	Controls.MessageScroll:SetScrollValue(1);
end

local function RefreshAll()
	UpdateOpenButton();
	if IsOpen() then
		RefreshLeaders();
		RefreshMessages();
		UpdateBridgeStatus();
	end
end

-- ---------------------------------------------------------------------------
-- Действия пользователя
-- ---------------------------------------------------------------------------
function SelectLeader(pid)
	g_Selected = pid;
	g_Unread[pid] = 0;
	if IsFeed(pid) then
		pcall(function() Controls.InputBox:DropFocus(); end);
		RefreshAll();
		return;
	end
	Enqueue({ type = "open_chat", leader = pid });
	RefreshAll();
	pcall(function() Controls.InputBox:TakeFocus(); end);
end

local function Open(pid)
	Controls.Window:SetHide(false);
	if pid ~= nil and pid ~= SEL_NONE then
		SelectLeader(pid);
	else
		if g_Selected ~= SEL_NONE then g_Unread[g_Selected] = 0; end
		RefreshAll();
		if g_Selected >= 0 then pcall(function() Controls.InputBox:TakeFocus(); end); end
	end
end

local function Close()
	Controls.Window:SetHide(true);
	pcall(function() Controls.InputBox:DropFocus(); end);
	UpdateOpenButton();
end

local function Toggle()
	if IsOpen() then Close(); else Open(nil); end
end

local function OnSend()
	local text = Controls.InputBox:GetText() or "";
	-- явный набор пробельных символов: %s в игре зависит от локали и задевает байты кириллицы
	text = string.gsub(text, "^[ \t\r\n]+", "");
	text = string.gsub(text, "[ \t\r\n]+$", "");
	if text == "" or g_Selected < 0 then return; end
	local localID = LocalID();
	local me = LeaderDisplay(localID);
	AddMessage(g_Selected, me .. " (вы)", text, "player");
	Enqueue({ type = "player_message", leader = g_Selected, text = text });
	g_Typing[g_Selected] = true;
	Controls.InputBox:ClearString();
	RefreshAll();
end

local function OnDealResponse(accepted)
	if g_Selected < 0 then return; end
	local deal = g_Deals[g_Selected];
	if deal == nil then return; end
	Enqueue({ type = "deal_response", leader = g_Selected, deal_id = deal.id, accepted = accepted });
	g_Deals[g_Selected] = nil;
	AddMessage(g_Selected, "Система", accepted and "Вы приняли предложение." or "Вы отклонили предложение.", "system");
	if not accepted then g_Typing[g_Selected] = true; end
	RefreshAll();
end

-- ---------------------------------------------------------------------------
-- API для моста (вызывается через FireTuner)
-- ---------------------------------------------------------------------------
function LLM_Poll()
	g_LastPoll = g_Time;
	local events = g_Outbox;
	g_Outbox = {};
	LLMJson.PrintPacket({ kind = "poll", turn = CurrentTurn(), localPlayer = LocalID(), events = events });
end

-- msg: {type="chat", leader=pid, text=..., deal={id=,text=}, open=bool}
--      {type="typing", leader=pid, on=bool}
--      {type="system", leader=pid, text=...}
--      {type="deal_clear", leader=pid}
--      {type="config", allow_unmet=bool, info=string}
function LLM_Deliver(msg)
	if msg == nil then return; end
	local t = msg.type;
	local pid = msg.leader;

	if t == "chat" then
		local leader = LeaderDisplay(pid);
		g_Typing[pid] = nil;
		AddMessage(pid, leader, msg.text or "", "leader");
		if msg.deal ~= nil then g_Deals[pid] = msg.deal; end
		if (not IsOpen()) or g_Selected ~= pid then
			g_Unread[pid] = (g_Unread[pid] or 0) + 1;
			pcall(function() UI.PlaySound("Play_MP_Chat_Message_Received"); end);
		end
		if msg.open then Open(pid); end
	elseif t == "typing" then
		g_Typing[pid] = msg.on and true or nil;
	elseif t == "system" then
		if pid ~= nil and pid >= 0 then
			g_Typing[pid] = nil;
			AddMessage(pid, "Система", msg.text or "", "system");
		end
	elseif t == "deal_clear" then
		g_Deals[pid] = nil;
	elseif t == "config" then
		if msg.allow_unmet ~= nil then g_AllowUnmet = msg.allow_unmet; end
		if msg.info ~= nil then g_BridgeInfo = msg.info; end
		if type(msg.names) == "table" then g_Names = msg.names; end
	elseif t == "feed" then
		-- {type="feed", feed="world"|"treaties", reset=bool, items={{author,text,kind}}, news=bool}
		local fid = FEEDS[msg.feed or ""];
		if fid ~= nil then
			if msg.reset then g_Conversations[fid] = {}; end
			local headers = 0;
			for _, it in ipairs(msg.items or {}) do
				AddMessage(fid, it.author, it.text, it.kind);
				if it.kind == "header" then headers = headers + 1; end
			end
			if msg.news and headers > 0 and ((not IsOpen()) or g_Selected ~= fid) then
				g_Unread[fid] = (g_Unread[fid] or 0) + headers;
				pcall(function() UI.PlaySound("Play_MP_Chat_Message_Received"); end);
			end
		end
	elseif t == "treaty_info" then
		-- {type="treaty_info", info={["<id>"]="Договоры: …"}}
		if type(msg.info) == "table" then g_TreatyInfo = msg.info; end
	elseif t == "restore_chat" then
		-- переписка из памяти моста после загрузки сейва: {leader=, reset=bool, messages={...}}
		if pid ~= nil and pid >= 0 then
			if msg.reset then g_Conversations[pid] = {}; end
			for _, m in ipairs(msg.messages or {}) do AddMessage(pid, m.author, m.text, m.kind); end
		end
	end
	RefreshAll();
	print("LLMQ_ACK|" .. tostring(t));
end

-- Снимок состояния игры для промптов
function LLM_Snapshot()
	local localID = LocalID();
	local snap = {
		kind = "snapshot",
		turn = CurrentTurn(),
		localPlayer = localID,
		era = Safe(function()
			local idx = Game.GetEras():GetCurrentEra();
			return Locale.Lookup(GameInfo.Eras[idx].Name);
		end, ""),
		players = {},
	};

	-- локализованные названия ресурсов
	snap.resNames = {};
	pcall(function()
		for row in GameInfo.Resources() do
			local cls = row.ResourceClassType;
			if cls == "RESOURCECLASS_STRATEGIC" or cls == "RESOURCECLASS_LUXURY" then
				snap.resNames[row.ResourceType] = Locale.Lookup(row.Name);
			end
		end
	end);

	local majors = PlayerManager.GetAliveMajors();
	for _, p in ipairs(majors) do
		local id = p:GetID();
		local cfg = PlayerConfigurations[id];
		local leader, civ = LeaderDisplay(id);
		local info = {
			id = id,
			leader = leader,
			civ = civ,
			leaderType = Safe(function() return cfg:GetLeaderTypeName(); end, ""),
			civType = Safe(function() return cfg:GetCivilizationTypeName(); end, ""),
			human = Safe(function() return p:IsHuman(); end, false),
			score = Safe(function() return p:GetScore(); end, 0),
			gold = Safe(function() return math.floor(p:GetTreasury():GetGoldBalance()); end, 0),
			goldPerTurn = Safe(function() return math.floor(p:GetTreasury():GetGoldYield() - p:GetTreasury():GetTotalMaintenance()); end, 0),
			favor = Safe(function() return p:GetFavor(); end, 0),
			cities = Safe(function() return p:GetCities():GetCount(); end, 0),
			military = Safe(function() return p:GetStats():GetMilitaryStrength(); end, 0),
			techs = Safe(function() return p:GetStats():GetNumTechsResearched(); end, 0),
			strategic = {},
			luxury = {},
			relations = {},
		};

		-- ресурсы
		pcall(function()
			local res = p:GetResources();
			for row in GameInfo.Resources() do
				local cls = row.ResourceClassType;
				if cls == "RESOURCECLASS_STRATEGIC" or cls == "RESOURCECLASS_LUXURY" then
					local n = Safe(function() return res:GetResourceAmount(row.Index); end, 0);
					if n ~= nil and n > 0 then
						if cls == "RESOURCECLASS_STRATEGIC" then
							info.strategic[row.ResourceType] = n;
						else
							info.luxury[row.ResourceType] = n;
						end
					end
				end
			end
		end);

		-- отношения со всеми встреченными
		for _, q in ipairs(majors) do
			local oid = q:GetID();
			if oid ~= id then
				local met = Safe(function() return p:GetDiplomacy():HasMet(oid); end, false);
				if met then
					info.relations[tostring(oid)] = {
						state = Safe(function()
							local idx = p:GetDiplomaticAI():GetDiplomaticStateIndex(oid);
							return GameInfo.DiplomaticStates[idx].StateType;
						end, ""),
						atWar = Safe(function() return p:GetDiplomacy():IsAtWarWith(oid); end, false),
						grievances = Safe(function() return p:GetDiplomacy():GetGrievancesAgainst(oid); end, 0),
						alliance = Safe(function()
							local a = p:GetDiplomacy():GetAllianceType(oid);
							if a == nil or a < 0 then return ""; end
							return GameInfo.Alliances[a].AllianceType;
						end, ""),
					};
				end
			end
		end

		table.insert(snap.players, info);
	end

	LLMJson.PrintPacket(snap);
end

-- ---------------------------------------------------------------------------
-- Игровые события -> мост
-- ---------------------------------------------------------------------------
local function OnDiplomacyMeet(p1, p2)
	local localID = LocalID();
	if p1 == localID and IsMajorAI(p2) then
		Enqueue({ type = "event", name = "meet", leader = p2 });
	elseif p2 == localID and IsMajorAI(p1) then
		Enqueue({ type = "event", name = "meet", leader = p1 });
	end
	RefreshAll();
end

local function OnDeclareWar(a, b)
	Enqueue({ type = "event", name = "war", a = a, b = b });
	RefreshAll();
end

local function OnMakePeace(a, b)
	Enqueue({ type = "event", name = "peace", a = a, b = b });
	RefreshAll();
end

local function OnCityOccupationChanged(playerID, cityID)
	local cityName = Safe(function()
		return Locale.Lookup(Players[playerID]:GetCities():FindID(cityID):GetName());
	end, "");
	Enqueue({ type = "event", name = "city_changed", owner = playerID, city = cityName });
end

-- Ядерные удары: Events.WMDDetonated(x, y, playerID, eWMD). Глобальная функция — мост ставит тот же
-- перехватчик и в уже запущенную игру (без перезагрузки), флаг не даёт подписаться дважды.
-- События копятся в глобальном LLM_ExtraEvents, мост забирает их вместе с LLM_Poll.
function LLM_InstallWMDHook()
	if LLM_WMDHooked then return; end
	LLM_WMDHooked = true;
	LLM_ExtraEvents = LLM_ExtraEvents or {};
	Events.WMDDetonated.Add(function(x, y, pid, wmd)
		local owner, city = -1, "";
		pcall(function()
			local plot = Map.GetPlot(x, y);
			owner = plot:GetOwner();
			local c = nil;
			pcall(function() c = Cities.GetPlotPurchaseCity(plot); end);
			if c == nil then pcall(function() c = CityManager.GetCityAt(x, y); end); end
			if c ~= nil then city = Locale.Lookup(c:GetName()); end
		end);
		table.insert(LLM_ExtraEvents, { type = "event", name = "wmd", attacker = pid, victim = owner,
			x = x, y = y, wmd = wmd, city = city, turn = Game.GetCurrentGameTurn() });
	end);
end

local function OnLocalTurnBegin()
	Enqueue({ type = "turn_begin" });
	RefreshAll();
end

-- ---------------------------------------------------------------------------
-- Ввод/обновление
-- ---------------------------------------------------------------------------
local function OnInput(pInputStruct)
	if not IsOpen() then return false; end
	local uiMsg = pInputStruct:GetMessageType();
	if uiMsg == KeyEvents.KeyUp and pInputStruct:GetKey() == Keys.VK_ESCAPE then
		Close();
		return true;
	end
	return false;
end

local function OnUpdate(dt)
	g_Time = g_Time + (dt or 0);
	if IsOpen() and (g_Time - g_LastStatusAt) > 1.0 then
		g_LastStatusAt = g_Time;
		UpdateBridgeStatus();
	end
end

-- ---------------------------------------------------------------------------
function Initialize()
	-- Надписи ставим из Lua: кириллица в атрибуте String у XML в игре не отображается
	Controls.Title:SetText("ИИ-дипломатия");
	Controls.OpenButton:SetText("ИИ-дипломатия");
	pcall(function() Controls.OpenButton:SetToolTipString("Открыть чат с лидерами (LLM)"); end);
	pcall(function() Controls.CloseButton:SetToolTipString("Закрыть (Esc)"); end);
	Controls.SendButton:SetText("Отправить");
	Controls.DealAccept:SetText("Принять");
	Controls.DealDecline:SetText("Отклонить");
	Controls.LeaderHeader:SetText("Выберите лидера слева");

	Controls.OpenButton:RegisterCallback(Mouse.eLClick, Toggle);
	Controls.CloseButton:RegisterCallback(Mouse.eLClick, Close);
	Controls.SendButton:RegisterCallback(Mouse.eLClick, OnSend);
	Controls.DealAccept:RegisterCallback(Mouse.eLClick, function() OnDealResponse(true); end);
	Controls.DealDecline:RegisterCallback(Mouse.eLClick, function() OnDealResponse(false); end);
	Controls.InputBox:RegisterCommitCallback(function() OnSend(); end);

	ContextPtr:SetInputHandler(OnInput, true);
	ContextPtr:SetUpdate(OnUpdate);

	-- Контексты из AddUserInterfaces игра создаёт скрытыми — показываем сами
	-- (и ещё раз после экрана загрузки, на случай если игра спрячет снова).
	ContextPtr:SetHide(false);
	Events.LoadScreenClose.Add(function() ContextPtr:SetHide(false); end);

	Events.DiplomacyMeet.Add(OnDiplomacyMeet);
	Events.DiplomacyDeclareWar.Add(OnDeclareWar);
	Events.DiplomacyMakePeace.Add(OnMakePeace);
	Events.CityOccupationChanged.Add(OnCityOccupationChanged);
	Events.LocalPlayerTurnBegin.Add(OnLocalTurnBegin);
	LLM_InstallWMDHook();

	-- Доступ из других контекстов (запасной путь для моста через InGame)
	ExposedMembers.LLMLeaders = {
		Poll = LLM_Poll,
		Deliver = LLM_Deliver,
		Snapshot = LLM_Snapshot,
	};

	Enqueue({ type = "ui_loaded" });
	print("LLMLeaders: UI loaded");
end

Initialize();
