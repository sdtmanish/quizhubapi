import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// --- Database Setup ---
const DB_URI = "mongodb+srv://sdtmanishbailwal_db_user:TErwqJTLIIDZsWpF@quizapp.vajuu70.mongodb.net/?retryWrites=true&w=majority&appName=QuizApp";

const QuestionSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    question: { type: String, required: true },
    options: { type: [String], required: true },
    correctAnswer: { type: Number, required: true },
    mediaUrl: { type: String, required: false },
  },
  { timestamps: true }
);

const Question = mongoose.models.Question || mongoose.model("Question", QuestionSchema);

const dbConnect = async () => {
  if (mongoose.connection.readyState >= 1) return;
  try {
    await mongoose.connect(DB_URI);
    console.log("✅ MongoDB connected successfully from WebSocket server.");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
  }
};
dbConnect();

// --- Helper Function ---
const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// --- In-memory game storage ---
let games = {};
let gameIdToPlayerIdMap = {};

// --- Socket.IO Events ---
io.on("connection", (socket) => {
  console.log("✅ User Connected:", socket.id);

  // --- Player/Admin joins a game ---
  socket.on("join_game", async ({ roomId, playerName, isAdmin, gameId }) => {
    if (!games[roomId]) {
      if (!isAdmin) {
        socket.emit("room_not_found");
        return;
      }
      games[roomId] = {
        admin: socket.id,
        adminName: playerName,
        players: {},
        scores: {},
        playerQuestions: {}, 
        playerQuestionsList: {}, 
        playerCurrentQIndex: {},
        answered: {},
        isQuizActive: false,
        adminQuestionList: [],
        currentQuestionIndex: -1,
        eliminatedOptions: {},
      };
      console.log(`⭐ Room ${roomId} created by admin ${playerName}`);
    }

    const game = games[roomId];

    // Admin reconnection logic - check by name instead of socket ID
    if (isAdmin) {
      if (game.adminName === playerName) {
        // This is the same admin reconnecting, update their socket ID
        console.log(`🔄 Admin ${playerName} reconnected to room ${roomId} with new socket ${socket.id}`);
        game.admin = socket.id;
      } else if (socket.id !== game.admin) {
        // Different admin trying to join
        socket.emit("admin_exists");
        return;
      }
    }

    socket.join(roomId);

    if (!isAdmin) {
      let playerId = socket.id;

      // --- Reconnection logic ---
      if (gameId && gameIdToPlayerIdMap[gameId]) {
        const oldSocketId = gameIdToPlayerIdMap[gameId];
        game.players[playerId] = game.players[oldSocketId];
        game.scores[playerId] = game.scores[oldSocketId];
        game.playerQuestions[playerId] = game.playerQuestions[oldSocketId];
        game.playerQuestionsList[playerId] = game.playerQuestionsList[oldSocketId];
        game.playerCurrentQIndex[playerId] = game.playerCurrentQIndex[oldSocketId];
        game.eliminatedOptions[playerId] = game.eliminatedOptions[oldSocketId] || [];

        delete game.players[oldSocketId];
        delete game.scores[oldSocketId];
        delete game.playerQuestions[oldSocketId];
        delete game.playerQuestionsList[oldSocketId];
        delete game.playerCurrentQIndex[oldSocketId];
        delete game.eliminatedOptions[oldSocketId];

        console.log(`🔄 Player ${playerName} reconnected to room ${roomId}`);
      } else {
        // --- New player joins ---
        game.players[playerId] = playerName || "Anonymous";
        game.scores[playerId] = 0;
        const allQuestions = await Question.find({});
        game.playerQuestionsList[playerId] = shuffleArray([...allQuestions]);
        game.playerCurrentQIndex[playerId] = -1;
        game.eliminatedOptions[playerId] = [];
        console.log(`➕ New player ${playerName} joined room ${roomId}.`);
        
        // **NEW:** Populate the current question for the player
        if (game.playerQuestionsList[playerId].length > 0) {
          game.playerQuestions[playerId] = game.playerQuestionsList[playerId][0];
          
          // If quiz is already active, send the current question immediately
          if (game.isQuizActive && game.currentQuestionIndex >= 0) {
            const currentQuestionIndex = Math.min(game.currentQuestionIndex, game.playerQuestionsList[playerId].length - 1);
            game.playerCurrentQIndex[playerId] = currentQuestionIndex;
            game.playerQuestions[playerId] = game.playerQuestionsList[playerId][currentQuestionIndex];
            
            // Send the question to the newly joined player
            setTimeout(() => {
              io.to(playerId).emit("show_question", {
                question: game.playerQuestions[playerId],
                index: currentQuestionIndex,
              });
            }, 200);
          }
        }
      }
      gameIdToPlayerIdMap[gameId] = playerId;
    }

    // Send updated game state to everyone in the room
    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      adminId: game.admin,
      adminName: game.adminName,
      questions: game.playerQuestions,
      currentQuestionIndex: game.currentQuestionIndex,
      eliminatedOptions: game.eliminatedOptions,
      isQuizActive: game.isQuizActive,
      adminQuestionList: game.adminQuestionList,
    });
  });

  // --- Admin starts quiz ---
  socket.on("start_quiz", async ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) return;

    const allQuestions = await Question.find({});
    if (allQuestions.length === 0) {
      socket.emit("no_questions_found");
      return;
    }

    // Initialize quiz
    game.adminQuestionList = shuffleArray(allQuestions);
    game.currentQuestionIndex = 0;
    game.isQuizActive = true;
    game.answered = {};
    game.eliminatedOptions = {};

    // Assign shuffled questions to each player & send them their first question
    for (const playerId in game.players) {
      const playerQuestions = game.playerQuestionsList[playerId];
      game.playerCurrentQIndex[playerId] = 0;
      
      if (playerQuestions && playerQuestions.length > 0) {
        game.playerQuestions[playerId] = playerQuestions[0];
      }
    }

    console.log(`🚀 Quiz started in room ${roomId}`);
    
    // First, broadcast the updated game state to everyone
    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      adminId: game.admin,
      adminName: game.adminName,
      questions: game.playerQuestions,
      currentQuestionIndex: game.currentQuestionIndex,
      eliminatedOptions: game.eliminatedOptions,
    });

    // Then send individual questions to players with a slight delay to ensure they're ready
    setTimeout(() => {
      for (const playerId in game.players) {
        const playerQuestions = game.playerQuestionsList[playerId];
        if (playerQuestions && playerQuestions.length > 0) {
          io.to(playerId).emit("show_question", {
            question: playerQuestions[0],
            index: 0,
          });
        }
      }
    }, 500); // 500ms delay to ensure players are ready
  });

  // --- Admin sends next question ---
  socket.on("next_question", ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) return;

    game.currentQuestionIndex++;
    game.answered = {};
    game.eliminatedOptions = {};

    if (game.currentQuestionIndex >= game.adminQuestionList.length) {
      game.isQuizActive = false;
      io.to(roomId).emit("quiz_ended", game.scores);
      return;
    }

    // Update the current question for each player
    for (const playerId in game.players) {
      game.playerCurrentQIndex[playerId]++;
      const nextQIndex = game.playerCurrentQIndex[playerId];
      const playerQuestions = game.playerQuestionsList[playerId];

      if (nextQIndex < playerQuestions.length) {
        const nextQuestion = playerQuestions[nextQIndex];
        game.playerQuestions[playerId] = nextQuestion;
        
        io.to(playerId).emit("show_question", {
          question: nextQuestion,
          index: nextQIndex,
        });
      } else {
        io.to(playerId).emit("player_quiz_ended");
      }
    }
    
    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      adminId: game.admin,
      adminName: game.adminName,
      questions: game.playerQuestions,
      currentQuestionIndex: game.currentQuestionIndex,
      eliminatedOptions: game.eliminatedOptions,
    });
  });

//Player Req for Eliminating wrong options
socket.on("request_elimination", ({roomId,playerId})=>{

  const game = games[roomId];
  if(!game) return;
  console.log(`Player ${playerId} requested elimination`);

  if(game.admin){
    io.to(game.admin).emit("elimination_requested", {playerId});
  }
})

  // --- Admin eliminates an option for a player ---
  socket.on("eliminate_option", ({ roomId, targetPlayerId, optionIndex }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) {
      return;
    }

    const parsedOptionIndex = parseInt(optionIndex, 10);
    if (isNaN(parsedOptionIndex)) {
      return;
    }

    if (!game.eliminatedOptions[targetPlayerId]) {
      game.eliminatedOptions[targetPlayerId] = [];
    }
    
    if (!game.eliminatedOptions[targetPlayerId].includes(parsedOptionIndex)) {
      game.eliminatedOptions[targetPlayerId].push(parsedOptionIndex);
    }

    io.to(targetPlayerId).emit("option_eliminated", { optionIndex: parsedOptionIndex });
    console.log(`➡️ Admin in room ${roomId} eliminated option ${parsedOptionIndex} for player ${targetPlayerId}`);
  });

  // --- Admin restores an eliminated option for a player ---
  socket.on("restore_option", ({ roomId, targetPlayerId, optionIndex }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) {
      return;
    }

    const parsedOptionIndex = parseInt(optionIndex, 10);
    if (isNaN(parsedOptionIndex)) {
      return;
    }

    if (game.eliminatedOptions[targetPlayerId]) {
      game.eliminatedOptions[targetPlayerId] = game.eliminatedOptions[targetPlayerId].filter(
        idx => idx !== parsedOptionIndex
      );
    }

    io.to(targetPlayerId).emit("option_restored", { optionIndex: parsedOptionIndex });
    console.log(`🔄 Admin in room ${roomId} restored option ${parsedOptionIndex} for player ${targetPlayerId}`);
  });

  // --- Player submits answer ---
  socket.on("submit_answer", ({ roomId, answer }) => {
    const game = games[roomId];
    if (!game || !game.players[socket.id]) return;
    if (game.answered[socket.id]) return;

    const currentIndex = game.playerCurrentQIndex[socket.id];
    const currentQuestion = game.playerQuestionsList[socket.id][currentIndex];
    if (!currentQuestion) return;

    game.answered[socket.id] = true;

    const isCorrect = answer === currentQuestion.correctAnswer;
    if (isCorrect) {
      game.scores[socket.id] += 10;
    }

    // Send answer result back to the player
    socket.emit("answer_result", {
      correctAnswer: currentQuestion.correctAnswer,
      isCorrect: isCorrect
    });

    io.to(roomId).emit("score_update", game.scores);

    //admin know this player has answered 
    io.to(roomId).emit("player_answered", {playerId:socket.id})
  });

  //handle admin exit
  socket.on("admin_exit", ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) {
      return;
    }
    
    io.to(roomId).emit("quiz_ended", { message: "The admin has ended the quiz." });
    
    socket.isIntentionalExit = true;
    delete games[roomId];
    console.log(`🗑️ Room ${roomId} has been completely removed.`);
  });
  
  // --- Handle disconnect ---
  socket.on("disconnect", () => {
    console.log("❌ User Disconnected:", socket.id);
    
    for (const roomId in games) {
      const game = games[roomId];
      if (!game) continue;

      if (socket.id === game.admin) {
        if (socket.isIntentionalExit) {
          console.log(`Admin ${socket.id} exited intentionally.`);
          return; 
        }

        const playerIds = Object.keys(game.players);
        if (playerIds.length > 0) {
          game.admin = playerIds[0];
          game.adminName = game.players[game.admin];
          delete game.players[game.admin];
          delete game.scores[game.admin];
          delete game.playerQuestions[game.admin];
          delete game.playerQuestionsList[game.admin];
          delete game.playerCurrentQIndex[game.admin];
          console.log(`Admin ${socket.id} disconnected. New admin is ${game.admin}.`);
        } else {
          delete games[roomId];
          console.log(`🗑️ Room ${roomId} deleted as no players remained.`);
        }
      } 
      else if (game.players[socket.id]) {
        console.log(`Player ${game.players[socket.id]} left room ${roomId}.`);
        delete game.players[socket.id];
        delete game.scores[socket.id];
        delete game.playerQuestions[socket.id];
        delete game.playerQuestionsList[socket.id];
        delete game.playerCurrentQIndex[socket.id];
      }

      io.to(roomId).emit("game_state", {
        players: game.players,
        scores: game.scores,
        adminId: game.admin,
        adminName: game.adminName,
        questions: game.playerQuestions,
        currentQuestionIndex: game.currentQuestionIndex,
        eliminatedOptions: game.eliminatedOptions,
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
});