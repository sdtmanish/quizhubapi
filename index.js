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
const DB_URI =
  "mongodb+srv://sdtmanishbailwal_db_user:TErwqJTLIIDZsWpF@quizapp.vajuu70.mongodb.net/?retryWrites=true&w=majority&appName=QuizApp";

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

const Question =
  mongoose.models.Question || mongoose.model("Question", QuestionSchema);

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
        playerCurrentQIndex: {},
        answered: {},
        isQuizActive: false,
        adminQuestionList: [],
        currentQuestionIndex: -1,
      };
      console.log(`⭐ Room ${roomId} created by admin ${playerName}`);
    }

    const game = games[roomId];

    if (isAdmin && socket.id !== game.admin) {
      socket.emit("admin_exists");
      return;
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
        game.playerCurrentQIndex[playerId] =
          game.playerCurrentQIndex[oldSocketId];

        delete game.players[oldSocketId];
        delete game.scores[oldSocketId];
        delete game.playerQuestions[oldSocketId];
        delete game.playerCurrentQIndex[oldSocketId];

        console.log(`🔄 Player ${playerName} reconnected to room ${roomId}`);
      } else {
        // --- New player joins ---
        game.players[playerId] = playerName || "Anonymous";
        game.scores[playerId] = 0;
        const allQuestions = await Question.find({});
        game.playerQuestions[playerId] = shuffleArray([...allQuestions]);
        game.playerCurrentQIndex[playerId] = 0;
      }
      gameIdToPlayerIdMap[gameId] = playerId;
    }

    // Send updated game state
    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      adminId: game.admin,
      adminName: game.adminName,
      questions: game?.playerQuestions,
      currentQuestionIndex: game?.playerCurrentQIndex[socket.id],
    });

    // If player reconnects while quiz is active → resume question
    if (
      !isAdmin &&
      game.isQuizActive &&
      game.playerCurrentQIndex[socket.id] !== -1
    ) {
      const qIndex = game.playerCurrentQIndex[socket.id];
      const playerQuestions = game.playerQuestions[socket.id];
      if (qIndex < playerQuestions.length) {
        const question = playerQuestions[qIndex];
        io.to(socket.id).emit("show_question", { question, index: qIndex });
      }
    }
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

    // Assign shuffled questions to each player
    for (const playerId in game.players) {
      game.playerQuestions[playerId] = shuffleArray([...allQuestions]);
      game.playerCurrentQIndex[playerId] = 0;
    }

    console.log(`🚀 Quiz started in room ${roomId}`);

    // Send first question to admin
    io.to(game.admin).emit("admin_show_question", {
      question: game.adminQuestionList[0],
      index: 0,
    });

    // Send first (different) question to each player
    for (const playerId in game.players) {
      io.to(playerId).emit("show_question", {
        question: game.playerQuestions[playerId][0],
        index: 0,
      });
    }
  });

  // --- Admin sends next question ---
  socket.on("next_question", ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) return;

    game.currentQuestionIndex++;
    game.answered = {};

    if (game.currentQuestionIndex < game.adminQuestionList.length) {
      io.to(game.admin).emit("admin_show_question", {
        question: game.adminQuestionList[game.currentQuestionIndex],
        index: game.currentQuestionIndex,
      });
    } else {
      game.isQuizActive = false;
      io.to(roomId).emit("quiz_ended", game.scores);
      return;
    }

    let anyPlayerHasQuestionsLeft = false;
    for (const playerId in game.players) {
      game.playerCurrentQIndex[playerId]++;
      const nextQIndex = game.playerCurrentQIndex[playerId];
      const playerQuestions = game.playerQuestions[playerId];

      if (nextQIndex < playerQuestions.length) {
        const nextQuestion = playerQuestions[nextQIndex];
        io.to(playerId).emit("show_question", {
          question: nextQuestion,
          index: nextQIndex,
        });
        anyPlayerHasQuestionsLeft = true;
      } else {
        io.to(playerId).emit("player_quiz_ended");
      }
    }

    if (!anyPlayerHasQuestionsLeft) {
      game.isQuizActive = false;
      io.to(roomId).emit("quiz_ended", game.scores);
    }

    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      adminId: game.admin,
      adminName: game.adminName,
      questions: game?.playerQuestions,
      // currentQuestionIndex: game?.playerCurrentQIndex,
    });
  });

  // --- Player submits answer ---
  socket.on("submit_answer", ({ roomId, questionId, answer }) => {
    const game = games[roomId];
    if (!game || !game.players[socket.id]) return;
    if (game.answered[socket.id]) return;

    const currentIndex = game.playerCurrentQIndex[socket.id];
    const currentQuestion = game.playerQuestions[socket.id][currentIndex];
    if (!currentQuestion) return;

    game.answered[socket.id] = true;

    if (answer === currentQuestion.correctAnswer) {
      game.scores[socket.id] += 10;
    }

    io.to(roomId).emit("score_update", game.scores);
  });

  // --- Handle disconnect ---
  socket.on("disconnect", () => {
    console.log("❌ User Disconnected:", socket.id);
    for (const roomId in games) {
      const game = games[roomId];
      if (!game) continue;

      if (socket.id === game.admin) {
        const playerIds = Object.keys(game.players);
        if (playerIds.length > 0) {
          game.admin = playerIds[0];
          game.adminName = game.players[game.admin];
          delete game.players[game.admin];
          delete game.scores[game.admin];
          delete game.playerQuestions[game.admin];
          delete game.playerCurrentQIndex[game.admin];
        } else {
          delete games[roomId];
          console.log(`🗑️ Room ${roomId} deleted`);
          continue;
        }
      }
      // Player data is preserved for reconnection
      io.to(roomId).emit("game_state", {
        players: game.players,
        scores: game.scores,
        adminId: game.admin,
        adminName: game.adminName,
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
});
