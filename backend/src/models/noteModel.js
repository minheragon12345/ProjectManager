const mongoose = require('mongoose');
const NOTE_STATUSES = ['not_done', 'done', 'cancelled'];

const NoteSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      default: null,
      index: true,
    },

    assignees: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],

    estimatedHours: {
      type: Number,
      min: 0,
      default: 0,
    },

    actualHours: {
      type: Number,
      min: 0,
      default: 0,
    },

    duration: {
      type: Number,
      min: 0,
      default: 0,
    },

    peopleRequired: {
      type: Number,
      min: 1,
      default: 1,
    },

    minDuration: {
      type: Number,
      min: 0,
      default: null,
    },

    marginalCost: {
      type: Number,
      min: 0,
      default: null,
    },

    actualStart: {
      type: Date,
      default: null,
    },

    actualEnd: {
      type: Date,
      default: null,
    },

    parentTask: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Note',
      default: null,
      index: true,
    },

    dependencies: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Note',
      },
    ],

    title: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },

    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },

    status: {
      type: String,
      enum: NOTE_STATUSES,
      default: 'not_done',
      index: true,
    },

    progress: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
      index: true,
    },

    deadline: {
      type: Date,
      default: null,
      index: true,
    },

    comments: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        text: { type: String, required: true, trim: true, maxlength: 2000 },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
      },
    ],

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

NoteSchema.index({ user: 1, isDeleted: 1, updatedAt: -1 });
NoteSchema.index({ project: 1, isDeleted: 1, status: 1 });
NoteSchema.index({ assignees: 1, isDeleted: 1, status: 1 });
NoteSchema.index({ parentTask: 1, isDeleted: 1 });
NoteSchema.index({ dependencies: 1, isDeleted: 1 });

const Note = mongoose.model('Note', NoteSchema);
module.exports = Note;
module.exports.NOTE_STATUSES = NOTE_STATUSES;
