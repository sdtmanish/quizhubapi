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

// --- In-memory game storage ---
let games = {}; // roomId -> { admin, players, scores, currentQ, questions, answered }

// --- Socket.IO Events ---
io.on("connection", (socket) => {
  console.log("✅ User Connected:", socket.id);

  // Player/Admin joins a game
  socket.on("join_game", ({ roomId, playerName, isAdmin }) => {
    // Create new room if admin
    if (!games[roomId]) {
      if (!isAdmin) {
        socket.emit("room_not_found");
        return;
      }

      games[roomId] = {
        admin: socket.id,
        adminName: playerName,
        players: {}, // real players only
        scores: {},
        currentQ: 0,
        questions: [],
        answered: {},
      };
      console.log(`⭐ Room ${roomId} created by admin ${playerName}`);
    }

    const game = games[roomId];

    // Prevent multiple admins
    if (isAdmin && socket.id !== game.admin) {
      socket.emit("admin_exists");
      return;
    }

    socket.join(roomId);

    // Only add to players if NOT admin
    if (!isAdmin) {
      game.players[socket.id] = playerName || "Anonymous";
      game.scores[socket.id] = 0;
    }

    // If quiz started, send current question to the new player
    if (game.questions.length > 0) {
      socket.emit("show_question", {
        question: game.questions[game.currentQ],
        index: game.currentQ,
      });
    }

    // Send updated game state to all
    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      currentQ: game.currentQ,
      adminId: game.admin,
      adminName: game.adminName,
      questions: game.questions,
    });
  });

  // Admin starts the quiz
  socket.on("start_quiz", async ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) return;

    const questions = await Question.find({});
    if (!questions.length) {
      socket.emit("no_questions_found");
      return;
    }

    game.questions = questions;
    game.currentQ = 0;
    game.answered = {};

    io.to(roomId).emit("show_question", {
      question: questions[0],
      index: 0,
    });

    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      currentQ: game.currentQ,
      adminId: game.admin,
      adminName: game.adminName,
      questions: game.questions,
    });
  });

  // Admin moves to next question
  socket.on("next_question", ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) return;

    game.currentQ++;
    game.answered = {};

    if (game.currentQ < game.questions.length) {
      io.to(roomId).emit("show_question", {
        question: game.questions[game.currentQ],
        index: game.currentQ,
      });
    } else {
      io.to(roomId).emit("quiz_ended", game.scores);
    }

    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      currentQ: game.currentQ,
      adminId: game.admin,
      adminName: game.adminName,
      questions: game.questions,
    });
  });

  // Player submits an answer
  socket.on("submit_answer", ({ roomId, answer }) => {
    const game = games[roomId];
    if (!game) return;

    // Prevent multiple submissions
    if (game.answered[socket.id]) return;

    const qIndex = game.currentQ;
    const currentQuestion = game.questions[qIndex];
    if (!currentQuestion) return;

    game.answered[socket.id] = true;

    if (answer === currentQuestion.correctAnswer) {
      game.scores[socket.id] += 10;
    }

    io.to(roomId).emit("score_update", game.scores);
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("❌ User Disconnected:", socket.id);

    for (const roomId in games) {
      const game = games[roomId];
      if (!game) continue;

      // Admin disconnects
      if (socket.id === game.admin) {
        const playerIds = Object.keys(game.players);
        if (playerIds.length > 0) {
          // Promote first player as new admin
          game.admin = playerIds[0];
          game.adminName = game.players[game.admin];
          delete game.players[game.admin];
          delete game.scores[game.admin];
        } else {
          delete games[roomId];
          console.log(`🗑️ Room ${roomId} deleted`);
          continue;
        }
      } else if (game.players[socket.id]) {
        // Player disconnects
        delete game.players[socket.id];
        delete game.scores[socket.id];
      }

      io.to(roomId).emit("game_state", {
        players: game.players,
        scores: game.scores,
        currentQ: game.currentQ,
        adminId: game.admin,
        adminName: game.adminName,
        questions: game.questions,
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
});
