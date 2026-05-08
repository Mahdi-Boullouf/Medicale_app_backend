import cron from 'node-cron';
import moment from 'moment';
import { Appointment } from '../model/appointment.model.js';
import { createNotification } from './notify.js';
import { io } from '../server.js';

export const initCronJobs = () => {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = moment();
      // Find accepted appointments that haven't had a reminder sent
      const appointments = await Appointment.find({ 
        status: 'accepted', 
        reminderSent: false 
      }).populate('doctor', 'fullName _id').populate('patient', 'fullName _id');

      for (const appt of appointments) {
        if (!appt.appointmentDate || !appt.time) continue;

        const dateStr = moment(appt.appointmentDate).format('YYYY-MM-DD');
        const apptDateTime = moment(`${dateStr} ${appt.time}`, 'YYYY-MM-DD HH:mm');
        
        const diffMinutes = apptDateTime.diff(now, 'minutes');

        // If the appointment is within the next 60 minutes
        if (diffMinutes > 0 && diffMinutes <= 60) {
          // Mark as sent so we don't notify again
          appt.reminderSent = true;
          await appt.save();

          // 1. Notify Patient
          if (appt.patient) {
            const patientNotification = {
              userId: appt.patient._id,
              fromUserId: appt.doctor._id,
              type: 'appointment_reminder',
              title: 'Upcoming Appointment Reminder ⏰',
              content: `Your appointment with Dr. ${appt.doctor.fullName || 'Doctor'} is in 1 hour.`,
              appointmentId: appt._id,
              meta: {
                appointmentType: appt.appointmentType,
                date: dateStr,
                time: appt.time,
                doctorId: appt.doctor._id,
                patientId: appt.patient._id,
              },
            };
            await createNotification(patientNotification);
            io.to(appt.patient._id.toString()).emit('appointment_reminder', patientNotification);
          }

          // 2. Notify Doctor
          if (appt.doctor) {
            const doctorNotification = {
              userId: appt.doctor._id,
              fromUserId: appt.patient._id,
              type: 'appointment_reminder',
              title: 'Upcoming Appointment Reminder ⏰',
              content: `You have an appointment with ${appt.patient.fullName || 'Patient'} in 1 hour.`,
              appointmentId: appt._id,
              meta: {
                appointmentType: appt.appointmentType,
                date: dateStr,
                time: appt.time,
                doctorId: appt.doctor._id,
                patientId: appt.patient._id,
              },
            };
            await createNotification(doctorNotification);
            io.to(appt.doctor._id.toString()).emit('appointment_reminder', doctorNotification);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error running appointment reminder cron job:', error);
    }
  });

  console.log('✅ Cron jobs initialized');
};
