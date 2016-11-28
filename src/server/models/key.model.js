import mongoose from 'mongoose';
const Schema = mongoose.Schema;

let keySchema = new Schema({
  index: Number,
  accessKeyId: String,
  secretAccessKey: String,
  jwrKey: String,
});

export default mongoose.model('key', keySchema);
