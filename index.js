import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { db } from './firebaseService.js'; // Убедитесь, что ваш firebaseService.js корректно настроен

// Ваш токен Telegram-бота
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
    console.error("Ошибка: Токен Telegram-бота не найден в переменных окружения. Убедитесь, что TELEGRAM_BOT_TOKEN установлен в файле .env");
    process.exit(1);
}

// Инициализируем бота, но пока не начинаем прослушивание
const bot = new TelegramBot(TOKEN, { polling: false });

// --- НОВАЯ ГЛОБАЛЬНАЯ ПЕРЕМЕННАЯ ДЛЯ КОНСТАНТ ---
let gameConstants = {}; // Здесь будут храниться загруженные константы
// --- КОНЕЦ НОВОЙ ГЛОБАЛЬНОЙ ПЕРЕМЕННОЙ ---

// --- ВСПОМОГАТЕЛЬНЫЕ ДАННЫЕ ДЛЯ ЛОГИКИ ДВИЖЕНИЯ ---
// Эти данные остаются в коде, так как они не являются изменяемыми игровыми параметрами
const DIRECTIONS_MAP = {
    "NORTH": { dx: 0, dy: 1 },
    "EAST": { dx: 1, dy: 0 },
    "SOUTH": { dx: 0, dy: -1 },
    "WEST": { dx: -1, dy: 0 }
};

const TURN_MAP = {
    "NORTH": { "STRAIGHT": "NORTH", "RIGHT": "EAST", "LEFT": "WEST", "BACK": "SOUTH" },
    "EAST": { "STRAIGHT": "EAST", "RIGHT": "SOUTH", "LEFT": "NORTH", "BACK": "WEST" },
    "SOUTH": { "STRAIGHT": "SOUTH", "RIGHT": "WEST", "LEFT": "EAST", "BACK": "NORTH" },
    "WEST": { "STRAIGHT": "WEST", "RIGHT": "NORTH", "LEFT": "SOUTH", "BACK": "EAST" }
};

const DIRECTION_EMOJIS = {
    "NORTH": "⬆️",
    "EAST": "➡️",
    "SOUTH": "⬇️",
    "WEST": "⬅️"
};

function getDirectionWithEmoji(direction) {
    const emoji = DIRECTION_EMOJIS[direction] || '';
    return `${direction} ${emoji}`;
}

// --- ФУНКЦИИ ПОМОЩНИКИ ---
function calculateNewPositionAndDirection(currentX, currentY, currentDirection, steps, turnChoice) {
    let newDirection = currentDirection;

    let turnType;
    if (turnChoice === 1) turnType = "RIGHT";
    else if (turnChoice === 2) turnType = "LEFT";
    else if (turnChoice === 3) turnType = "STRAIGHT";
    else if (turnChoice === 4) turnType = "BACK";

    newDirection = TURN_MAP[currentDirection][turnType];

    const { dx, dy } = DIRECTIONS_MAP[newDirection];

    let newX = currentX + dx * steps;
    let newY = currentY + dy * steps;

    // ИСПОЛЬЗУЕМ gameConstants.boardSize
    newX = Math.max(1, Math.min(gameConstants.boardSize, newX));
    newY = Math.max(1, Math.min(gameConstants.boardSize, newY));

    return { newX, newY, newDirection };
}

// --- НОВАЯ ФУНКЦИЯ ДЛЯ АВТОМАТИЧЕСКОЙ ПРОДАЖИ УЧАСТКОВ ---
async function handleAutoSale(bot, userId, username, currentWallet, requiredAmount) {
    const boardCellsRef = db.ref('board_cells');
    const allBoardCellsSnapshot = await boardCellsRef.once('value');
    const allBoardCells = allBoardCellsSnapshot.val();

    let ownedPlots = [];
    if (allBoardCells) {
        for (const fieldKey in allBoardCells) {
            const cellData = allBoardCells[fieldKey];
            // Продавать можно только участки, у которых есть цена покупки
            if (cellData && cellData.ownerId === userId && cellData.purchasePrice > 0) {
                ownedPlots.push({
                    fieldKey: fieldKey,
                    ...cellData
                });
            }
        }
    }

    if (ownedPlots.length === 0) {
        // Нечего продавать
        return { success: false, newWallet: currentWallet, messages: [] };
    }

    let saleMessages = [];
    let wallet = currentWallet;
    const salePercentage = 0.7;
    const bankBalanceRef = db.ref('bank/bank_balance'); // Ссылка на узел баланса Банка


    let saleNotificationMessageToOthers = `📣 ${username} был вынужден продать следующие участки, чтобы продолжить игру:`;
    let soldPlotsForNotification = [];

    while (wallet < requiredAmount && ownedPlots.length > 0) {
        const plotIndexToSell = Math.floor(Math.random() * ownedPlots.length);
        const plotToSell = ownedPlots[plotIndexToSell];
        const [x, y] = plotToSell.fieldKey.split('_');

        ownedPlots.splice(plotIndexToSell, 1);

        const salePrice = Math.floor(plotToSell.purchasePrice * salePercentage);

        const bankUpdateResult = await bankBalanceRef.transaction((currentBalance) => {
            const newBalance = (currentBalance || 0) - salePrice;
            // Убрали проверку на банкротство банка. Теперь он может уходить в минус, чтобы выкупить участок.
            return newBalance;
        });

        if (bankUpdateResult.committed) {
            wallet += salePrice;

            // Возвращаем участок в гос. собственность

            await boardCellsRef.child(plotToSell.fieldKey).update({ ownerId: 0 });

            const saleMessage = `\n🚨 Недостаточно средств! Автоматически продан ваш участок (${x}, ${y}) за ${salePrice} монет. Деньги получены из Банка.`;
            saleMessages.push(saleMessage);
            soldPlotsForNotification.push(`(${x}, ${y})`);

        } else {
            const failedSaleMessage = `\n⚠️ Попытка продать участок (${x}, ${y}) не удалась из-за технической ошибки с банком.`;
            saleMessages.push(failedSaleMessage);
        }
    }

    // Уведомляем других игроков, если что-то было продано
    if (soldPlotsForNotification.length > 0) {
        saleNotificationMessageToOthers += ` ${soldPlotsForNotification.join(', ')}. Теперь они снова доступны для покупки!`;
        const allPlayersSnapshot = await db.ref('players').once('value');
        const allPlayers = allPlayersSnapshot.val();
        if (allPlayers) {
            for (const otherPlayerId in allPlayers) {
                if (otherPlayerId !== userId && allPlayers[otherPlayerId].status === "playing" && allPlayers[otherPlayerId].chatId) {
                    bot.sendMessage(allPlayers[otherPlayerId].chatId, saleNotificationMessageToOthers)
                        .catch(err => console.error(`Ошибка при уведомлении игрока ${otherPlayerId} о продаже:`, err.message));
                }
            }
        }
    }

    return {
        success: wallet >= requiredAmount,
        newWallet: wallet,
        messages: saleMessages
    };
}

// --- НОВАЯ АСИНХРОННАЯ ФУНКЦИЯ ДЛЯ ИНИЦИАЛИЗАЦИИ БОТА ---
async function initializeBot() {
    try {
        const configRef = db.ref('game_config');
        const bankBalanceRef = db.ref('bank/bank_balance'); // Ссылка на узел баланса Банка

        const snapshot = await configRef.once('value');
        const bankSnapshot = await bankBalanceRef.once('value'); // Считываем текущий баланс Банка

        if (snapshot.exists()) {
            gameConstants = snapshot.val();
            console.log("Константы игры успешно загружены из Firebase:", gameConstants);

            // Добавляем 'initialBankBalance' в список обязательных констант
            const requiredConstants = ['initialWalletBalance', 'initialX', 'initialY', 'initialDirection', 'boardSize', 'initialBankBalance'];
            const missingConstants = requiredConstants.filter(key => typeof gameConstants[key] === 'undefined');

            if (missingConstants.length > 0) {
                console.error(`Ошибка: Отсутствуют следующие важные константы игры в Realtime Database: ${missingConstants.join(', ')}. Убедитесь, что они добавлены в '/game_config'.`);
                process.exit(1);
            }

        } else {
            console.warn("В Realtime Database не найден узел 'game_config'. Используем значения по умолчанию и запишем их в БД.");
            gameConstants = {
                initialWalletBalance: 300,
                initialX: 2,
                initialY: 2,
                initialDirection: "NORTH",
                boardSize: 3,
                initialBankBalance: 1000, // Значение по умолчанию для начального баланса Банка
            };
            await configRef.set(gameConstants);
            console.log("Константы игры по умолчанию успешно записаны в Firebase.");
        }

        // Инициализируем баланс Банка, если его нет
        if (!bankSnapshot.exists()) {
            await bankBalanceRef.set(gameConstants.initialBankBalance);
            console.log(`Начальный баланс банка (${gameConstants.initialBankBalance}) установлен.`);
        } else {
            console.log(`Баланс банка загружен: ${bankSnapshot.val()}`);
        }

        // Теперь, когда константы загружены, запускаем прослушивание сообщений бота
        bot.startPolling();
        console.log('Бот запущен и прослушивает сообщения...');

    } catch (error) {
        console.error("Критическая ошибка при загрузке констант игры из Firebase:", error);
        process.exit(1);
    }
}

// Вызываем функцию инициализации бота
initializeBot();

// --- ОБРАБОТЧИК СООБЩЕНИЙ ТЕЛЕГРАМ БОТА ---
bot.on('message', async (msg) => {
    // Убедимся, что константы загружены. Это обычно не нужно, так как bot.startPolling()
    // вызывается после загрузки, но для надежности можно добавить проверку.
    if (Object.keys(gameConstants).length === 0) {
        console.warn("Попытка обработки сообщения до полной загрузки gameConstants. Сообщение будет проигнорировано.");
        bot.sendMessage(msg.chat.id, "Бот ещё инициализируется. Пожалуйста, подождите немного и повторите попытку.");
        return;
    }


    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const username = msg.from.first_name || msg.from.username || `Пользователь ${userId}`;
    const text = msg.text;

    const playerRef = db.ref(`players/${userId}`);
    const boardCellsRef = db.ref('board_cells');

    // Обработка команды "0" (начало игры)
    if (text === '0') {
        try {
            const snapshot = await playerRef.once('value');

            if (snapshot.exists() && snapshot.val().status === "playing") {
                const { currentX, currentY, currentDirection, wallet, turnsPlayed } = snapshot.val();
                const displayTurnsPlayed = turnsPlayed !== undefined ? turnsPlayed : 0;
                bot.sendMessage(chatId, `Вы уже в игре, ${username}! Ваша текущая позиция: (${currentX}, ${currentY}), смотрите ${getDirectionWithEmoji(currentDirection)}. На балансе: ${wallet} монет. Ходов сыграно: ${displayTurnsPlayed}. Отправьте любое сообщение (кроме 0), чтобы бросить кубики.`);
            } else {
                await playerRef.set({
                    currentX: gameConstants.initialX,
                    currentY: gameConstants.initialY,
                    currentDirection: gameConstants.initialDirection,
                    status: "playing",
                    username: username,
                    wallet: gameConstants.initialWalletBalance,
                    turnsPlayed: 0,
                    chatId: chatId
                });
                bot.sendMessage(chatId, `Добро пожаловать в игру, ${username}! Вы на поле (${gameConstants.initialX}, ${gameConstants.initialY}), смотрите ${getDirectionWithEmoji(gameConstants.initialDirection)}. Начинаете с ${gameConstants.initialWalletBalance} монет. Это ваш 1-й ход! Отправьте любое сообщение (кроме 0), чтобы бросить кубики.`);
            }
        } catch (error) {
            console.error("Ошибка при старте игры:", error);
            bot.sendMessage(chatId, "Произошла ошибка при попытке начать игру. Попробуйте еще раз.");
        }
    }
    // Обработка команды "/buy" (покупка участка)
    else if (text === '/buy') {
        try {
            const snapshot = await playerRef.once('value');

            if (!snapshot.exists() || snapshot.val().status !== "playing") {
                bot.sendMessage(chatId, `Привет, ${username}! Чтобы начать игру, отправьте цифру 0.`);
                return;
            }

            let playerData = snapshot.val();
            const currentX = playerData.currentX;
            const currentY = playerData.currentY;
            let playerWallet = playerData.wallet || 0;

            const fieldKey = `${currentX}_${currentY}`;
            const cellRef = boardCellsRef.child(fieldKey);
            const cellSnapshot = await cellRef.once('value');
            const cellData = cellSnapshot.val();

            if (!cellData) {
                bot.sendMessage(chatId, `Вы находитесь на поле (${currentX}, ${currentY}), но информация об этом поле не найдена. Здесь нельзя ничего купить.`);
                return;
            }

            const purchasePrice = cellData.purchasePrice;
            const currentOwnerId = cellData.ownerId;

            if (purchasePrice === 0) {
                bot.sendMessage(chatId, `Поле (${currentX}, ${currentY}) не продается.`);
                return;
            }

            if (currentOwnerId === userId) {
                bot.sendMessage(chatId, `Вы уже владеете полем (${currentX}, ${currentY}).`);
                return;
            }

            if (currentOwnerId !== 0) {
                const ownerPlayerSnapshot = await db.ref(`players/${currentOwnerId}`).once('value');
                const ownerUsername = ownerPlayerSnapshot.val() ? ownerPlayerSnapshot.val().username : 'Неизвестный игрок';
                bot.sendMessage(chatId, `Поле (${currentX}, ${currentY}) уже принадлежит игроку ${ownerUsername}.`);
                return;
            }

            if (playerWallet < purchasePrice) {
                bot.sendMessage(chatId, `У вас недостаточно монет для покупки поля (${currentX}, ${currentY}). Необходимо ${purchasePrice}, у вас ${playerWallet}.`);
                return;
            }

            // --- НОВОЕ: Снимаем деньги с игрока и отправляем в Банк ---
            const bankBalanceRef = db.ref('bank/bank_balance');
            await bankBalanceRef.transaction((currentBalance) => {
                return (currentBalance || 0) + purchasePrice; // Деньги поступают в Банк
            });

            playerWallet -= purchasePrice; // Списываем с игрока
            playerData.wallet = playerWallet;
            await playerRef.update({ wallet: playerWallet }); // Обновляем кошелек игрока

            let newLandCost = cellData.land_cost || 0;
            let bonusFromNeighbors = 0;

            const adjOffsets = [
                { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
                { dx: 1, dy: 0 }, { dx: -1, dy: 0 }
            ];

            for (const offset of adjOffsets) {
                const adjX = currentX + offset.dx;
                const adjY = currentY + offset.dy;

                // ИСПОЛЬЗУЕМ gameConstants.boardSize
                if (adjX >= 1 && adjX <= gameConstants.boardSize && adjY >= 1 && adjY <= gameConstants.boardSize) {
                    const adjFieldKey = `${adjX}_${adjY}`;
                    const adjCellSnapshot = await boardCellsRef.child(adjFieldKey).once('value');
                    const adjCellData = adjCellSnapshot.val();

                    if (adjCellData && adjCellData.ownerId === userId) {
                        bonusFromNeighbors += 2;
                    }
                }
            }

            if (bonusFromNeighbors > 0) {
                newLandCost += bonusFromNeighbors;
            }

            await cellRef.update({ ownerId: userId, land_cost: newLandCost });

            let purchaseConfirmationMessage = `Поздравляем! Вы успешно купили поле (${currentX}, ${currentY}) за ${purchasePrice} монет. Деньги поступили в Банк. Ваш баланс: ${playerWallet} монет.`; // Изменено сообщение

            if (bonusFromNeighbors > 0) {
                purchaseConfirmationMessage += `\n💰 Благодаря владению соседними участками, стоимость приземления на этом поле теперь составляет ${newLandCost} монет (бонус +${bonusFromNeighbors} за близость!).`;
            }

            bot.sendMessage(chatId, purchaseConfirmationMessage);

            try {
                const allPlayersSnapshot = await db.ref('players').once('value');
                const allPlayers = allPlayersSnapshot.val();
                if (allPlayers) {
                    for (const otherPlayerId in allPlayers) {
                        if (otherPlayerId !== userId && allPlayers[otherPlayerId].status === "playing" && allPlayers[otherPlayerId].chatId) {
                            const otherPlayerChatId = allPlayers[otherPlayerId].chatId;
                            bot.sendMessage(otherPlayerChatId, `🎉 ${username} купил поле (${currentX}, ${currentY})!`)
                                .catch(err => console.error(`Ошибка при уведомлении игрока ${otherPlayerId} о покупке:`, err.message));
                        }
                    }
                }
            } catch (notifyError) {
                console.error("Ошибка при уведомлении других игроков о покупке:", notifyError);
            }

        } catch (error) {
            console.error("Ошибка при попытке покупки участка:", error);
            bot.sendMessage(chatId, "Произошла ошибка при попытке покупки участка. Попробуйте еще раз.");
        }
    }

    // Обработка команды "/sale" (подготовка к продаже участков)
    else if (text === '/sale') {
        try {
            const snapshot = await playerRef.once('value');

            if (!snapshot.exists() || snapshot.val().status !== "playing") {
                bot.sendMessage(chatId, `Привет, ${username}! Чтобы начать игру, отправьте цифру 0.`);
                return;
            }

            const allBoardCellsSnapshot = await boardCellsRef.once('value');
            const allBoardCells = allBoardCellsSnapshot.val();

            let ownedPlots = [];
            if (allBoardCells) {
                for (const fieldKey in allBoardCells) {
                    const cellData = allBoardCells[fieldKey];
                    if (cellData && cellData.ownerId === userId) {
                        ownedPlots.push({
                            fieldKey: fieldKey,
                            purchasePrice: cellData.purchasePrice
                        });
                    }
                }
            }

            if (ownedPlots.length === 0) {
                bot.sendMessage(chatId, `У вас нет участков для продажи, ${username}.`);
                return;
            }

            const salePercentage = 0.7;

            const keyboard = {
                inline_keyboard: ownedPlots.map(plot => {
                    const [x, y] = plot.fieldKey.split('_');
                    const estimatedSalePrice = Math.floor(plot.purchasePrice * salePercentage);
                    return [{
                        text: `Поле (${x}, ${y}) - Продать за ${estimatedSalePrice} монет`,
                        callback_data: `sale_${plot.fieldKey}`
                    }];
                })
            };

            bot.sendMessage(chatId, `Выберите участок для продажи, ${username}:`, { reply_markup: keyboard });

        } catch (error) {
            console.error("Ошибка при подготовке к продаже участка:", error);
            bot.sendMessage(chatId, "Произошла ошибка при попытке показать ваши участки. Попробуйте еще раз.");
        }
    }

    // Обработка любого другого сообщения (ход игрока)
    else if (text && text !== '0') {
        try {
            const snapshot = await playerRef.once('value');

            if (!snapshot.exists() || snapshot.val().status !== "playing") {
                bot.sendMessage(chatId, `Привет, ${username}! Чтобы начать игру, отправьте цифру 0.`);
                return;
            }

            let playerData = snapshot.val();
            let currentX = playerData.currentX;
            let currentY = playerData.currentY;
            let currentDirection = playerData.currentDirection;
            let playerWallet = playerData.wallet || 0;
            let turnsPlayed = playerData.turnsPlayed !== undefined ? playerData.turnsPlayed : 0;

            if (playerData.skipNextTurn) {
                await playerRef.update({ skipNextTurn: null });
                bot.sendMessage(chatId, `Вы пропустили этот ход из-за эффекта предыдущего поля! Вы все еще на поле (${currentX}, ${currentY}), смотрите ${getDirectionWithEmoji(currentDirection)}. На балансе: ${playerWallet} монет. Ходов сыграно: ${turnsPlayed}.`);
                return;
            }

            turnsPlayed++;

            const stepsRoll = Math.floor(Math.random() * 2) + 1;
            const turnRoll = Math.floor(Math.random() * 4) + 1;

            let turnMessage = "";
            if (turnRoll === 1) turnMessage = "вправо";
            else if (turnRoll === 2) turnMessage = "влево";
            else if (turnRoll === 3) turnMessage = "прямо";
            else if (turnRoll === 4) turnMessage = "назад";

            const { newX, newY, newDirection } = calculateNewPositionAndDirection(
                currentX, currentY, currentDirection, stepsRoll, turnRoll
            );

            const fieldKey = `${newX}_${newY}`;
            const cellSnapshot = await boardCellsRef.child(fieldKey).once('value');
            const cellData = cellSnapshot.val();

            let landCost = cellData ? (cellData.land_cost || 0) : 0;
            let isTaxOffice = false; // Флаг для налоговой инспекции
            let responseMessage = `Вы бросили кубик и выпало ${stepsRoll} шагов! Вы повернули ${turnMessage}. `;

            // --- НОВАЯ ЛОГИКА ДЛЯ НАЛОГОВОЙ ИНСПЕКЦИИ ---
            // Проверяем, является ли поле налоговой инспекцией по его 'effect'
            if (cellData && cellData.type === 'special' && cellData.effect === 'tax_office') {
                isTaxOffice = true;
                let totalTax = 0;
                const allBoardCellsSnapshot = await boardCellsRef.once('value');
                const allBoardCells = allBoardCellsSnapshot.val();

                if (allBoardCells) {
                    for (const key in allBoardCells) {
                        const plot = allBoardCells[key];
                        // Суммируем land_cost всех участков, принадлежащих игроку
                        if (plot.ownerId === userId && plot.land_cost > 0) {
                            totalTax += plot.land_cost;
                        }
                    }
                }

                landCost = totalTax; // Налог равен сумме land_cost всех участков игрока
                responseMessage += `\n\nВы попали в Налоговую инспекцию! 👮‍♂️`;
                if (landCost > 0) {
                    responseMessage += `\nСумма налога, рассчитанная на основе ваших владений, составляет ${landCost} монет.`;
                } else {
                    responseMessage += `\nТак как у вас нет доходных участков, налог не взимается.`;
                }
            }

            let finalX = newX;
            let finalY = newY;
            let finalDirection = newDirection;
            let skipNextTurn = null;
            let paidAmount = 0;

            const currentOwnerId = cellData ? cellData.ownerId : 0; // Определяем владельца
            const ownerPlayerSnapshot = await db.ref(`players/${currentOwnerId}`).once('value');
            const ownerUsername = ownerPlayerSnapshot.val() ? ownerPlayerSnapshot.val().username : 'Государство';


            if (currentOwnerId === userId) {
                responseMessage += `\n\nВы попали на свое поле (${newX}, ${newY}). Плата за приземление не взимается!`;
            } else {
                let canAfford = playerWallet >= landCost;

                // Если не хватает денег и нужно платить (а не получать бонус)
                if (!canAfford && landCost > 0) {
                    responseMessage += `\n🚨 Не хватает средств для оплаты аренды (${landCost} монет). Попытка автоматической продажи участков...`;
                    const autoSaleResult = await handleAutoSale(bot, userId, username, playerWallet, landCost);

                    playerWallet = autoSaleResult.newWallet;
                    responseMessage += autoSaleResult.messages.join('');

                    canAfford = autoSaleResult.success; // Обновляем флаг, удалось ли собрать нужную сумму
                }

                // Если в итоге денег хватает (или не нужно было платить / нужно было получить бонус)
                if (canAfford) {
                    if (landCost !== 0) {
                        playerWallet -= landCost;
                        paidAmount = landCost;

                        if (landCost > 0) {
                            if (!isTaxOffice) {
                                responseMessage += `\n\nВы попали на поле (${newX}, ${newY}). \nВладелец поля: ${ownerUsername}(${currentOwnerId}). \nВы оплатили ${paidAmount} монет за вход. `;
                            } else {
                                responseMessage += `\nВы оплатили налог в размере ${paidAmount} монет.`;
                            }
                        } else {
                            responseMessage += `\n\nВы попали на поле (${newX}, ${newY}) и получили бонус в размере ${-paidAmount} монет!`;
                        }

                        if (ownerPlayerSnapshot.exists()) {
                            const ownerData = ownerPlayerSnapshot.val();
                            const ownerWallet = ownerData.wallet || 0;
                            const newOwnerWallet = ownerWallet + paidAmount;

                            await db.ref(`players/${currentOwnerId}`).update({ wallet: newOwnerWallet });

                            if (landCost > 0) {
                                responseMessage += `\n${ownerUsername} получил ${paidAmount} монет.`;
                                if (ownerData.chatId) {
                                    try {
                                        bot.sendMessage(ownerData.chatId, `💰 Вам пришла оплата! Игрок ${username} приземлился на вашем поле (${newX}, ${newY}) и заплатил ${paidAmount} монет. Ваш новый баланс: ${newOwnerWallet} монет.`);
                                    } catch (notificationError) {
                                        console.error(`Ошибка при отправке уведомления владельцу ${ownerUsername} (chatId: ${ownerData.chatId}):`, notificationError);
                                    }
                                }
                            }
                        } else {
                            // Деньги идут в/из Банка, если владелец - государство (ownerId: 0)
                            const bankBalanceRef = db.ref('bank/bank_balance');
                            await bankBalanceRef.transaction((currentBalance) => {
                                return (currentBalance || 0) + paidAmount;
                            });
                            responseMessage += `\nДеньги (${paidAmount > 0 ? paidAmount : -paidAmount} монет) ${paidAmount > 0 ? 'поступили в' : 'получены из'} Банка.`;
                        }
                    } else {
                        if (!isTaxOffice) { // Не дублируем сообщение для налоговой с нулевым налогом
                            responseMessage += `\n\nВы попали на поле (${newX}, ${newY}). Это нейтральная территория, плата не взимается.`;
                        }
                    }
                } else {
                    // --- ИЗМЕНЕНО: ЛОГИКА ПРОИГРЫША ---
                    // Денег не хватило даже после продажи всех участков (или если участков не было)
                    responseMessage += `\n\nGAME OVER!\nУ вас недостаточно средств (${playerWallet} монет) для оплаты аренды в ${landCost} монет. Вы выбываете из игры.`;

                    // Отправляем итоговое сообщение о проигрыше
                    bot.sendMessage(chatId, responseMessage);

                    // Уведомляем остальных игроков
                    const allPlayersSnapshot = await db.ref('players').once('value');
                    const allPlayers = allPlayersSnapshot.val();
                    if (allPlayers) {
                        for (const otherPlayerId in allPlayers) {
                            if (otherPlayerId !== userId && allPlayers[otherPlayerId].status === "playing" && allPlayers[otherPlayerId].chatId) {
                                bot.sendMessage(allPlayers[otherPlayerId].chatId, `☠️ Игрок ${username} обанкротился и выбыл из игры!`)
                                    .catch(err => console.error(`Ошибка при уведомлении игрока ${otherPlayerId} о банкротстве:`, err.message));
                            }
                        }
                    }

                    // Удаляем игрока из базы данных
                    await playerRef.remove();
                    return;
                    // --- КОНЕЦ ЛОГИКИ ПРОИГРЫША ---
                }
            }


            // --- ЛОГИКА СПЕЦИАЛЬНЫХ ЭФФЕКТОВ ---
            if (cellData && cellData.type === 'special' && finalX === newX && finalY === newY && !isTaxOffice) { // Добавлена проверка !isTaxOffice
                responseMessage += `\n${cellData.message}`;

                switch (cellData.effect) {
                    case 'go_back':
                        // ИСПОЛЬЗУЕМ gameConstants.boardSize
                        finalX = Math.max(1, Math.min(gameConstants.boardSize, finalX - DIRECTIONS_MAP[finalDirection].dx * cellData.value));
                        finalY = Math.max(1, Math.min(gameConstants.boardSize, finalY - DIRECTIONS_MAP[finalDirection].dy * cellData.value));
                        responseMessage += ` Вы вернулись на поле (${finalX}, ${finalY}).`;
                        break;
                    case 'extra_turn':
                        break;
                    case 'lose_turn':
                        skipNextTurn = true;
                        break;
                }
            }

            let bonusMessage = '';
            if (turnsPlayed % 5 === 0) {
                playerWallet += 9;
                bonusMessage = `\n🎁 Поздравляем! Вы совершили ${turnsPlayed}-й ход и получили бонус: +9 монет!`;
            }

            let fieldDetails = '';
            if (cellData) {
                const fieldLandCost = cellData.land_cost || 0;
                const fieldPurchasePrice = cellData.purchasePrice || 0;
                const fieldOwnerUsername = ownerUsername;

                fieldDetails += `\n\n📊 Информация о поле (${finalX}, ${finalY}):`;
                fieldDetails += `\n • Владелец: ${fieldOwnerUsername}.`;

                if (fieldLandCost > 0) {
                    fieldDetails += `\n • Стоимость приземления: ${fieldLandCost} монет.`;
                } else {
                    fieldDetails += `\n • Приземление на это поле бесплатное.`;
                }

                if (fieldPurchasePrice > 0 && cellData.ownerId === 0) {
                    fieldDetails += `\n • Цена покупки: ${fieldPurchasePrice} монет.`;
                } else if (cellData.ownerId === 0 && fieldPurchasePrice === 0) {
                    fieldDetails += `\n • Это поле не продается.`;
                }
            }
            responseMessage += fieldDetails;


            responseMessage += `\nТеперь вы на поле (${finalX}, ${finalY}), смотрите ${getDirectionWithEmoji(finalDirection)}. На вашем балансе: ${playerWallet} монет. Это ваш ${turnsPlayed}-й ход.`;
            responseMessage += bonusMessage;


            playerData.status = "playing";
            playerData.currentX = finalX;
            playerData.currentY = finalY;
            playerData.currentDirection = finalDirection;
            playerData.wallet = playerWallet;
            playerData.turnsPlayed = turnsPlayed;
            if (skipNextTurn !== null) {
                playerData.skipNextTurn = skipNextTurn;
            }

            await playerRef.update(playerData);
            bot.sendMessage(chatId, responseMessage);

            try {
                const allPlayersSnapshot = await db.ref('players').once('value');
                const allPlayers = allPlayersSnapshot.val();

                if (allPlayers) {
                    for (const otherPlayerId in allPlayers) {
                        if (otherPlayerId !== userId &&
                            allPlayers[otherPlayerId].status === "playing" &&
                            allPlayers[otherPlayerId].chatId) {

                            const otherPlayerChatId = allPlayers[otherPlayerId].chatId;
                            let notificationMessage = `📢 ${username} переместился на (${finalX}, ${finalY})!`;
                            if (cellData && cellData.type === 'special' && finalX === newX && finalY === newY) {
                                notificationMessage += ` (На поле ${finalX},${finalY}: ${cellData.message.split('.')[0]}!)`;
                            }
                            if (turnsPlayed % 5 === 0) {
                                notificationMessage += ` (Ход №${turnsPlayed} - ${username} получил бонус!)`;
                            }
                            bot.sendMessage(otherPlayerChatId, notificationMessage)
                                .catch(err => {
                                    console.error(`Ошибка при уведомлении игрока ${otherPlayerId} (${otherPlayerChatId}):`, err.message);
                                });
                        }
                    }
                }
            } catch (notifyError) {
                console.error("Ошибка при уведомлении других игроков:", notifyError);
            }

        } catch (error) {
            console.error("Ошибка при обработке хода:", error);
            bot.sendMessage(chatId, "Произошла ошибка при броске кубиков или обработке поля. Попробуйте еще раз.");
        }
    }
    else {
        bot.sendMessage(chatId, `Извините, ${username}, я вас не понял. Отправьте 0, чтобы начать игру, /buy, чтобы купить участок, /sale, чтобы продать участок, или любое другое сообщение, чтобы бросить кубики.`);
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const chatId = message.chat.id;
    const userId = String(callbackQuery.from.id);
    const username = callbackQuery.from.first_name || callbackQuery.from.username || `Пользователь ${userId}`;
    const data = callbackQuery.data;

    const playerRef = db.ref(`players/${userId}`);
    const boardCellsRef = db.ref('board_cells');

    if (data.startsWith('sale_')) {
        const fieldKeyToSell = data.substring(5);

        try {
            const playerSnapshot = await playerRef.once('value');
            if (!playerSnapshot.exists() || playerSnapshot.val().status !== "playing") {
                await bot.answerCallbackQuery(callbackQuery.id, { text: "Ваша игровая сессия истекла или вы не в игре." });
                bot.editMessageText(`Продажа невозможна. ${username}, чтобы начать игру, отправьте цифру 0.`, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    reply_markup: { inline_keyboard: [] }
                });
                return;
            }

            let playerData = playerSnapshot.val();
            let playerWallet = playerData.wallet || 0;

            const cellRef = boardCellsRef.child(fieldKeyToSell);
            const cellSnapshot = await cellRef.once('value');
            const cellData = cellSnapshot.val();

            if (!cellData || cellData.ownerId !== userId) {
                await bot.answerCallbackQuery(callbackQuery.id, { text: "Вы не владеете этим участком или он уже продан.", show_alert: true });
                bot.editMessageText(`Участок (${fieldKeyToSell.replace('_', ', ')}) больше не принадлежит вам или не существует. Продажа отменена.`, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    reply_markup: { inline_keyboard: [] }
                });
                return;
            }

            const purchasePrice = cellData.purchasePrice;
            const salePercentage = 0.7;
            const salePrice = Math.floor(purchasePrice * salePercentage);

            // --- НОВОЕ: Списываем деньги с Банка ---
            const bankBalanceRef = db.ref('bank/bank_balance');
            const bankUpdateResult = await bankBalanceRef.transaction((currentBalance) => {
                const newBalance = (currentBalance || 0) - salePrice;
                // Убрали проверку на банкротство банка. Теперь он может уходить в минус, чтобы выкупить участок.
                return newBalance;
            });

            // Проверяем, что транзакция с Банком прошла успешно
            if (bankUpdateResult.committed) {
                playerWallet += salePrice; // Только если Банк смог выдать деньги

                await playerRef.update({ wallet: playerWallet });
                await cellRef.update({ ownerId: 0 }); // Возвращаем участок Государству

                await bot.answerCallbackQuery(callbackQuery.id, { text: `Участок (${fieldKeyToSell.replace('_', ', ')}) продан за ${salePrice} монет! Деньги получены из Банка.` });

                bot.editMessageText(`Вы успешно продали поле (${fieldKeyToSell.replace('_', ', ')}) за ${salePrice} монет. Деньги получены из Банка. Ваш баланс: ${playerWallet} монет. Теперь это поле снова принадлежит Государству.`, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    reply_markup: { inline_keyboard: [] }
                });

                const allPlayersSnapshot = await db.ref('players').once('value');
                const allPlayers = allPlayersSnapshot.val();
                if (allPlayers) {
                    for (const otherPlayerId in allPlayers) {
                        if (otherPlayerId !== userId && allPlayers[otherPlayerId].status === "playing" && allPlayers[otherPlayerId].chatId) {
                            const otherPlayerChatId = allPlayers[otherPlayerId].chatId;
                            bot.sendMessage(otherPlayerChatId, `📣 ${username} продал поле (${fieldKeyToSell.replace('_', ', ')})! Теперь оно снова доступно для покупки!`)
                                .catch(err => console.error(`Ошибка при уведомлении игрока ${otherPlayerId} о продаже:`, err.message));
                        }
                    }
                }

            } else {
                // Если транзакция с Банком не удалась
                await bot.answerCallbackQuery(callbackQuery.id, { text: "Произошла техническая ошибка при обращении к Банку.", show_alert: true });
                bot.editMessageText(`Произошла ошибка при продаже участка (${fieldKeyToSell.replace('_', ', ')}): не удалось списать средства со счета Банка. Попробуйте еще раз.`, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    reply_markup: { inline_keyboard: [] }
                });
            }

        } catch (error) {
            console.error("Ошибка при обработке продажи участка через callback:", error);
            await bot.answerCallbackQuery(callbackQuery.id, { text: "Произошла ошибка при продаже участка.", show_alert: true });
            bot.editMessageText(`Произошла ошибка при продаже участка (${fieldKeyToSell.replace('_', ', ')}). Попробуйте еще раз.`, {
                chat_id: chatId,
                message_id: message.message_id,
                reply_markup: { inline_keyboard: [] }
            });
        }
    }
});

bot.on('polling_error', (error) => console.log("Ошибка polling'а:", error));
