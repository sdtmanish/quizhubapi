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

// --- Helper Function ---
// Fisher-Yates shuffle algorithm
const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// --- In-memory game storage ---
let games = {}; // roomId -> { admin, players, scores, quizQuestions, currentQuestionIndex, answered, isQuizActive }

io.on("connection", (socket) => {
  console.log("✅ User Connected:", socket.id);

  socket.on("join_game", async ({ roomId, playerName, isAdmin }) => {
    let game = games[roomId];

    if (!game) {
      if (!isAdmin) {
        socket.emit("room_not_found");
        return;
      }
      // If no room exists, create one with the admin and initial state
      game = {
        admin: socket.id,
        adminName: playerName,
        players: {},
        scores: {},
        quizQuestions: [], // ⭐ Centralized questions, populated on 'start_quiz'
        currentQuestionIndex: -1, // ⭐ Start at -1
        answered: {},
        isQuizActive: false,
      };
      games[roomId] = game;
      console.log(`⭐ Room ${roomId} created by admin ${playerName}`);
    }

    if (isAdmin && socket.id !== game.admin) {
      socket.emit("admin_exists");
      return;
    }
    
    socket.join(roomId);

    if (!isAdmin) {
      if (!game.players[socket.id]) {
        game.players[socket.id] = playerName || "Anonymous";
        game.scores[socket.id] = 0;
      }
    }

    // Send updated game state to all
    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      adminId: game.admin,
      adminName: game.adminName,
    });
    
    // If quiz is active, send the current question to the newly connected user
    if (game.isQuizActive && game.currentQuestionIndex !== -1) {
      const question = game.quizQuestions[game.currentQuestionIndex];
      if (isAdmin) {
        socket.emit("admin_show_question", { question, index: game.currentQuestionIndex });
      } else {
        socket.emit("show_question", { question, index: game.currentQuestionIndex });
      }
    }
  });

  // ⭐ NEW: 'start_quiz' will now load the questions and start the quiz
  socket.on("start_quiz", async ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) return;

    const allQuestions = await Question.find({});
    if (allQuestions.length === 0) {
      socket.emit("no_questions_found");
      return;
    }
    
    game.quizQuestions = shuffleArray(allQuestions);
    game.isQuizActive = true;
    game.currentQuestionIndex = 0; // The first question is at index 0
    game.answered = {};

    const firstQuestion = game.quizQuestions[0];
    
    // Send the first question to the admin
    io.to(game.admin).emit("admin_show_question", {
      question: firstQuestion,
      index: 0,
    });

    // Send the first question to all players
    io.to(roomId).emit("show_question", {
      question: firstQuestion,
      index: 0,
    });
    console.log(`⏩ Quiz started. Question 1 sent to room ${roomId}`);
  });


  socket.on("next_question", ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) return;

    game.currentQuestionIndex++;
    game.answered = {};

    if (game.currentQuestionIndex < game.quizQuestions.length) {
      const nextQuestion = game.quizQuestions[game.currentQuestionIndex];

      // Send the next question to the admin
      io.to(game.admin).emit("admin_show_question", {
        question: nextQuestion,
        index: game.currentQuestionIndex,
      });

      // Send the next question to all players
      io.to(roomId).emit("show_question", {
        question: nextQuestion,
        index: game.currentQuestionIndex,
      });
      console.log(`⏩ Admin advanced to question ${game.currentQuestionIndex + 1} in room ${roomId}`);
    } else {
      // Quiz is over
      game.isQuizActive = false;
      io.to(roomId).emit("quiz_ended");
      console.log(`🏁 Quiz ended for room ${roomId}`);
    }

    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      adminId: game.admin,
      adminName: game.adminName,
    });
  });

  // Player submits an answer
  socket.on("submit_answer", ({ roomId, questionId, answer }) => {
    const game = games[roomId];
    if (!game || !game.players[socket.id]) return;
    if (game.answered[socket.id]) return;

    const currentQuestion = game.quizQuestions[game.currentQuestionIndex];
    if (!currentQuestion || currentQuestion._id.toString() !== questionId) return;

    game.answered[socket.id] = true;

    if (answer === currentQuestion.correctAnswer) {
      game.scores[socket.id] += 10;
    }

    io.to(roomId).emit("score_update", game.scores);
  });
  
  socket.on("disconnect", () => {
    console.log("❌ User Disconnected:", socket.id);
    // You can add logic here to handle disconnections, but the core game state logic is now stable.
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
});